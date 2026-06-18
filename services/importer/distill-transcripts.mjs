#!/usr/bin/env node
// Distill condensed Claude Code transcripts into durable memories. Runs ON THE BOX
// (needs `claude -p` Haiku, the VOYAGE key, and the local Postgres). Reads the
// condensed/ dir produced by condense-transcripts.mjs on the Mac.
//
// For each session: Haiku extracts 0..N durable items (decisions, learnings,
// tech-debt, requirements). Each item is content-hash deduped against the DB,
// embedded with voyage-4-large, and inserted with source_kind set for enumeration.
//
//   DRY_RUN=true  node distill-transcripts.mjs ./condensed         # extract+print, no writes
//   DRY_RUN=false VOYAGE_API_KEY=… node distill-transcripts.mjs ./condensed
//
// Env: CONCURRENCY (default 4), LIMIT (cap sessions, for testing), MODEL.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const PROJECT_ID = process.env.PROJECT_ID || 'nodex';
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-haiku-4-5';
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const LIMIT = Number(process.env.LIMIT || 0);
const DIR = process.argv[2] || './condensed';
const DATABASE_URL = process.env.DATABASE_URL ||
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.PGHOST || '127.0.0.1'}:5432/${process.env.POSTGRES_DB}`;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const VALID_TYPES = new Set(['episodic', 'semantic', 'procedural', 'entity']);
const INSTRUCTION = `You are distilling one Claude Code coding session for the Nodex project into durable long-term memory.
Extract ONLY durable, reusable knowledge — skip transient chatter, tool mechanics, and anything that won't matter next week.
Return a STRICT JSON array (no prose, no markdown fences). Each element:
  {"type":"semantic|procedural|episodic|entity",
   "title":"<=90 char headline",
   "content":"1-5 sentences, self-contained, no 'we'/session refs that lose meaning out of context",
   "importance":0.3-0.9,
   "sourceKind":"decision|implementation|tech-debt|requirements|learning|research|plan",
   "tags":["..."],
   "metadata":{}}
Rules:
- 0 to 8 items. If the session has nothing durable, return [].
- type: semantic=durable fact/decision, procedural=how-to/process, episodic=what happened/outcome, entity=a tracked thing.
- Flag any KNOWN BUG / shortcut / TODO / "we should later" as sourceKind:"tech-debt" with metadata {"severity":"low|med|high","file":"<path if known>"}.
- Decisions ("we decided X because Y") -> sourceKind:"decision", type:"semantic".
- Output the JSON array and nothing else.`;

function runHaiku(transcript) {
  return new Promise((resolve) => {
    const prompt = `${INSTRUCTION}\n\n===== SESSION TRANSCRIPT (condensed) =====\n${transcript}`;
    const child = spawn('claude', ['-p', '--model', MODEL, '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 180_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      clearTimeout(killer);
      resolve({ out, err });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseItems(rawEnvelope) {
  // claude -p --output-format json => {"type":"result","result":"<text>",...}
  let text = rawEnvelope;
  try {
    const env = JSON.parse(rawEnvelope);
    text = env.result ?? env.text ?? rawEnvelope;
  } catch { /* maybe already plain text */ }
  // strip markdown fences if the model added them
  text = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // grab the first [...] block
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function embed(text) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], model: 'voyage-4-large', input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

// ---------- load manifest ----------
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
let sessions = manifest.filter((m) => m.file);
if (LIMIT > 0) sessions = sessions.slice(0, LIMIT);

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const existing = new Set(
  (await pool.query(`SELECT content_sha256 FROM memory.memories WHERE content_sha256 IS NOT NULL`))
    .rows.map((r) => r.content_sha256),
);

let totalItems = 0, inserted = 0, dupSkipped = 0, emptySessions = 0, failed = 0;

async function processSession(m) {
  let body;
  try { body = readFileSync(join(DIR, m.file), 'utf8'); } catch { return; }
  const { out, err } = await runHaiku(body);
  const items = parseItems(out);
  if (!items.length) {
    emptySessions++;
    if (err && !out) { failed++; console.error(`  ! ${m.sessionId.slice(0, 8)} haiku err: ${err.slice(0, 120)}`); }
    return;
  }
  for (const it of items) {
    totalItems++;
    const type = VALID_TYPES.has(it.type) ? it.type : 'semantic';
    const title = String(it.title || 'untitled').slice(0, 200);
    const content = String(it.content || '').trim();
    if (content.length < 20) continue;
    const hash = sha256(content);
    if (existing.has(hash)) { dupSkipped++; continue; }
    existing.add(hash);
    const impWord = { critical: 0.9, high: 0.8, med: 0.55, medium: 0.55, low: 0.35, minor: 0.3 };
    const rawImp = typeof it.importance === 'string'
      ? (impWord[it.importance.toLowerCase()] ?? Number(it.importance))
      : Number(it.importance);
    const importance = Math.min(0.95, Math.max(0.2, rawImp || 0.5));
    const sourceKind = String(it.sourceKind || 'claude-session');
    const tags = Array.isArray(it.tags) ? it.tags : [];
    if (DRY_RUN) {
      inserted++;
      console.log(`   [${type}/${sourceKind}] ${title}`);
      continue;
    }
    let vec;
    try { vec = await embed(`${title}\n${content}`); }
    catch (e) { console.error(`  embed failed: ${e.message}`); continue; }
    await pool.query(
      `INSERT INTO memory.memories
         (project_id,type,title,content,importance,metadata,embedding,status,source_kind,content_sha256,event_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7::halfvec,'active',$8,$9,$10)`,
      [PROJECT_ID, type, title, content, importance,
       JSON.stringify({ ...(it.metadata && typeof it.metadata === 'object' ? it.metadata : {}),
         sessionId: m.sessionId, project: m.project, gitBranch: m.gitBranch || null,
         tags: ['claude-session', 'distilled', ...tags] }),
       `[${vec.join(',')}]`, sourceKind, hash, m.eventDate || null],
    );
    inserted++;
  }
}

// ---------- bounded-concurrency runner ----------
console.log(`distill ${DRY_RUN ? 'DRY-RUN' : 'LIVE'} — ${sessions.length} sessions, model=${MODEL}, conc=${CONCURRENCY}`);
let idx = 0, done = 0;
async function worker() {
  while (idx < sessions.length) {
    const m = sessions[idx++];
    const n = idx;
    try { await processSession(m); } catch (e) { failed++; console.error(`  ! ${m.sessionId.slice(0, 8)}: ${e.message}`); }
    done++;
    if (done % 4 === 0 || done === sessions.length) console.error(`  progress ${done}/${sessions.length} (items=${totalItems}, ins=${inserted})`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sessions.length) }, worker));

console.log(`\n${DRY_RUN ? 'DRY-RUN' : 'LIVE'} done: ${inserted} ${DRY_RUN ? 'would-insert' : 'inserted'}, ${totalItems} extracted, ${dupSkipped} dedup-skipped, ${emptySessions} empty-sessions, ${failed} failed`);
await pool.end();
