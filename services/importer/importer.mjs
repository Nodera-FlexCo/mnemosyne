#!/usr/bin/env node
// Phase-A one-time knowledge backfill (Nodex-scoped).
// Runs on the Mac (where the knowledge files live); writes to the box DB over an
// SSH tunnel (DATABASE_URL). DRY_RUN=true (default) reports without embedding/writing.
//
//   DRY_RUN=true  node importer.mjs            # report only
//   DRY_RUN=false VOYAGE_API_KEY=… DATABASE_URL=… node importer.mjs   # live ingest
//
// LIVE ingest requires memory-mcp BUILT FIRST (cd ../memory-mcp && npm ci && npm run
// build): rows are written through the shared invariant path
// ../memory-mcp/dist/db/insert-memory.js (content_sha256 + metadata.dupCandidates +
// BOTH embedding columns — importer rows indistinguishable from storeMemory rows).
// DRY_RUN needs no build.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import pg from 'pg';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const PROJECT_ID = process.env.PROJECT_ID || 'nodex';
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL ||
  (process.env.POSTGRES_USER
    ? `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.PGHOST || '127.0.0.1'}:5432/${process.env.POSTGRES_DB}`
    : '');
const EMBED_MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-4-large';
const CONTEXT_MODEL = process.env.VOYAGE_CONTEXT_MODEL || 'voyage-context-4';
const H = homedir();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Normalize a source path to a STABLE repo-relative key so dedup works regardless
// of WHERE the importer ran. The first migration ran on the box from a staged copy
// under IMPORT_SRC_BASE (paths like /opt/mnemosyne/import-src/Developer/Apps/Nodex/…);
// re-runs from the Mac use ${HOME}/Developer/Apps/Nodex/…. Both normalize to the same
// key (e.g. "Developer/Apps/Nodex/.claude/plans/x/index.md"), making re-ingest idempotent.
const IMPORT_SRC_BASE = process.env.IMPORT_SRC_BASE || '/opt/mnemosyne/import-src/';
function pathKey(p) {
  if (p.startsWith(IMPORT_SRC_BASE)) return p.slice(IMPORT_SRC_BASE.length);
  if (p.startsWith(H + '/')) return p.slice(H.length + 1);
  return p;
}

// ---------- source manifest (Nodex-scoped) ----------
const NODEX = process.env.NODEX_DIR || join(H, 'Developer/Apps/Nodex');
const MEM = process.env.MEM_DIR || join(H, '.claude/projects/-Users-development-Developer-Apps-Nodex/memory');
const APPLE = process.env.APPLE_DIR || join(H, 'Developer/Apple App Store Web');
const CORPORA = [
  { kind: 'claude-memory', dir: MEM, recurse: false },
  { kind: 'research', dir: join(NODEX, '.claude/research'), recurse: false },
  { kind: 'notes', dir: join(NODEX, '.claude/notes'), recurse: false },
  { kind: 'plan', dir: join(NODEX, '.claude/plans'), recurse: true },
  { kind: 'review', dir: join(NODEX, '.claude/reviews'), recurse: true },
  { kind: 'tech-debt', dir: join(NODEX, '.claude/tech-debt'), recurse: false },
  { kind: 'brainstorm', dir: join(NODEX, '.claude/brainstorm'), recurse: true },
  { kind: 'docs', dir: join(NODEX, 'docs'), recurse: true },
  { kind: 'docs-root', dir: NODEX, recurse: false,
    rootPattern: /^(ARCHITECTURE|IMPLEMENTATION|DEPLOYMENT|TESTING|PHASE.*|.*SUMMARY|project-overview)\.md$/i },
  { kind: 'apple-design', dir: APPLE, recurse: false },
];

// ---------- secrets ----------
// Files matching SECRET_FLAG are migrated (their doc content is valuable) but the
// secret-shaped TOKEN is scrubbed by REDACTIONS, and the file is flagged for review.
const SECRET_FLAG = /(sk_live_|sk_test_|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_|xoxb-|AIza[0-9A-Za-z_\-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const REDACTIONS = [
  // scrub real secret tokens (keep surrounding doc)
  [/sk_live_[A-Za-z0-9]+/g, '<redacted-stripe-key>'],
  [/sk_test_[A-Za-z0-9]+/g, '<redacted-stripe-key>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>'],
  [/ghp_[A-Za-z0-9]{30,}/g, '<redacted-gh-token>'],
  [/github_pat_[A-Za-z0-9_]+/g, '<redacted-gh-pat>'],
  [/xoxb-[A-Za-z0-9-]+/g, '<redacted-slack-token>'],
  [/AIza[0-9A-Za-z_\-]{30,}/g, '<redacted-google-key>'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>'],
  // known infra values
  [/aa217787-2e3b-462b-81aa-99b7c7cb9373/gi, '<redacted-web3forms-key>'],
  [/859b4a03642ac2a45e7157bfd9024c21/gi, '<redacted-cf-account-id>'],
  [/\/Users\/[^/\s]+\/Keys\/[^\s)'"`]+/g, '<ssh-key-path>'],
  [/\broot@(?:\d{1,3}\.){3}\d{1,3}\b/g, 'root@<ip>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [/\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b/g, '<ipv6>'],
];
function redact(text) {
  let t = text, n = 0;
  for (const [re, rep] of REDACTIONS) t = t.replace(re, () => { n++; return rep; });
  return { text: t, n };
}

// ---------- classify ----------
function classify(kind, name) {
  if (kind === 'claude-memory') {
    if (name.startsWith('feedback_')) return 'procedural';
    return 'semantic';
  }
  return { research: 'semantic', notes: 'semantic', plan: 'procedural', review: 'episodic',
    'tech-debt': 'entity', brainstorm: 'semantic', docs: 'semantic', 'docs-root': 'semantic',
    'apple-design': 'semantic' }[kind] || 'semantic';
}
const DATE_RE = /(20\d{2})-(\d{2})-(\d{2})/;
function eventDate(name, full) {
  const m = name.match(DATE_RE);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  try { return statSync(full).mtime.toISOString().slice(0, 10); } catch { return null; }
}
function titleOf(name, content) {
  const m = content.match(/^#\s+(.+)$/m);
  return (m ? m[1] : basename(name, '.md')).slice(0, 200);
}

function listFiles(c) {
  const out = [];
  if (!existsSync(c.dir)) return out;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { if (c.recurse) walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      if (c.rootPattern && !c.rootPattern.test(e.name)) continue;
      out.push(p);
    }
  };
  walk(c.dir);
  return out;
}

// ---------- collect ----------
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 4 }) : null;
const existing = new Set();      // content_sha256 dedup (handles renamed/moved files)
const existingUris = new Set();  // source_uri (path) dedup — idempotent across redaction changes
if (pool) {
  try {
    const r = await pool.query(`SELECT content_sha256 FROM memory.memories WHERE content_sha256 IS NOT NULL`);
    for (const row of r.rows) existing.add(row.content_sha256);
    const r2 = await pool.query(`SELECT source_uri FROM memory.memories WHERE source_uri IS NOT NULL`);
    for (const row of r2.rows) existingUris.add(pathKey(row.source_uri));
  } catch (e) { console.error('warn: could not read existing hashes/uris:', e.message); }
}

const seen = new Set();
const stats = {};
const toIngest = [];
let dupCount = 0, redactedFiles = 0, supersededCount = 0;
const secretFlagged = [];

for (const c of CORPORA) {
  for (const f of listFiles(c)) {
    if (existingUris.has(pathKey(f))) { dupCount++; continue; } // already ingested (repo-relative path) — skip
    let content;
    try { content = readFileSync(f, 'utf8'); } catch { continue; }
    if (!content.trim()) continue;
    const name = basename(f);
    if (SECRET_FLAG.test(content)) secretFlagged.push(f);
    const isStub = c.kind === 'research' && content.length < 220 && /redirect|superseded|see\s/i.test(content);
    const { text: red, n } = redact(content);
    if (n > 0) redactedFiles++;
    const hash = sha256(red);
    if (existing.has(hash) || seen.has(hash)) { dupCount++; continue; }
    seen.add(hash);
    const type = classify(c.kind, name);
    const superseded = isStub || /superseded|retired/i.test(name);
    if (superseded) supersededCount++;
    toIngest.push({
      kind: c.kind, type, title: titleOf(name, red), content: red, source_uri: f,
      event_date: eventDate(name, f), content_sha256: hash, chars: red.length,
      status: superseded ? 'superseded' : 'active',
      importance: c.kind === 'research' ? 0.7 : c.kind === 'tech-debt' ? 0.6 : 0.5,
    });
    (stats[c.kind] ??= { files: 0, chars: 0, types: {} });
    stats[c.kind].files++; stats[c.kind].chars += red.length;
    stats[c.kind].types[type] = (stats[c.kind].types[type] || 0) + 1;
  }
}

// ---------- report ----------
console.log(`\n=== Phase-A importer ${DRY_RUN ? 'DRY-RUN (no writes)' : 'LIVE INGEST'} — project=${PROJECT_ID} ===`);
let totFiles = 0, totChars = 0;
for (const [k, s] of Object.entries(stats)) {
  totFiles += s.files; totChars += s.chars;
  console.log(`  ${k.padEnd(14)} ${String(s.files).padStart(4)} memories  ~${Math.round(s.chars / 1000)}k chars  ${JSON.stringify(s.types)}`);
}
console.log(`  ----`);
console.log(`  TOTAL: ${totFiles} memories  ~${Math.round(totChars / 1000)}k chars  (~${Math.round(totChars / 4000)}k embed tokens)`);
console.log(`  dedup-skipped: ${dupCount}   redacted-files: ${redactedFiles}   superseded: ${supersededCount}   secret-flagged (migrated w/ token scrubbed): ${secretFlagged.length}`);
if (secretFlagged.length) console.log(`  ⚠ secret-shaped tokens scrubbed — review these & put any real secret in secrets-mcp:\n   ${secretFlagged.join('\n   ')}`);
console.log(`  sample:`);
for (const r of toIngest.slice(0, 10)) console.log(`   [${r.type}/${r.status}] ${r.title}  (${r.kind}, ${r.event_date}, ${Math.round(r.chars/1000)}k)`);

if (DRY_RUN) {
  console.log(`\nDRY-RUN complete — nothing written. Re-run with DRY_RUN=false to ingest.`);
  if (pool) await pool.end();
  process.exit(0);
}

// ---------- live ingest ----------
if (!VOYAGE_API_KEY) { console.error('VOYAGE_API_KEY required for live ingest'); process.exit(1); }
// Shared invariant write path (tech-debt 4761d86c): every insert goes through
// memory-mcp's insertMemoryRow — content_sha256, dupCandidates flagging (per row,
// AFTER its vectors are computed), and BOTH embedding columns. Loaded lazily so
// DRY_RUN never needs the memory-mcp build.
let insertMemoryRow;
try {
  ({ insertMemoryRow } = await import('../memory-mcp/dist/db/insert-memory.js'));
} catch (e) {
  console.error(`cannot load ../memory-mcp/dist/db/insert-memory.js — build memory-mcp first (cd services/memory-mcp && npm ci && npm run build): ${e.message}`);
  process.exit(1);
}
async function embed(text) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], model: EMBED_MODEL, input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}
// Contextual embedding for embedding_v2 (the recall-bearing column: searchMemory
// filters `embedding_v2 IS NOT NULL`, so a v2-less row is invisible until a manual
// backfill — the AC-304 unembedded-rows hole this importer used to create).
// One-chunk-per-doc: inputs=[[text]], dim 1024, int8 — same recipe as storeMemory.
async function embedContextual(text) {
  const res = await fetch('https://api.voyageai.com/v1/contextualizedembeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: [[text]],
      model: CONTEXT_MODEL,
      input_type: 'document',
      output_dimension: 1024,
      output_dtype: 'int8',
    }),
  });
  if (!res.ok) throw new Error(`voyage ctx ${res.status}: ${await res.text()}`);
  // Response: { data: [ { data: [ { embedding } ] } ] } — one doc, one chunk.
  return (await res.json()).data[0].data[0].embedding;
}
let ingested = 0;
for (const r of toIngest) {
  const body = `${r.title}\n${r.content}`.slice(0, 110000); // ~27k token cap
  let vec, vec2;
  try { vec = await embed(body); vec2 = await embedContextual(body); }
  catch (e) { console.error(`embed failed ${r.source_uri}: ${e.message}`); continue; }
  // insertMemoryRow recomputes content_sha256 from the (redacted) content — the
  // same value as r.content_sha256 above, so the pre-dedupe sets stay coherent.
  await insertMemoryRow(pool, {
    projectId: PROJECT_ID, type: r.type, title: r.title, content: r.content,
    importance: r.importance, metadata: { tags: ['migrated', r.kind] },
    sourceKind: r.kind, status: r.status, sourceUri: r.source_uri, eventDate: r.event_date,
  }, { vec, vec2 });
  ingested++;
  if (ingested % 25 === 0) console.log(`  ingested ${ingested}/${toIngest.length}...`);
}
console.log(`\nLIVE: ingested ${ingested} memories.`);
await pool.end();
