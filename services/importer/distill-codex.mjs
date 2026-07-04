#!/usr/bin/env node
// Ingest the Codex CLI session index (state_5.sqlite -> threads.json) as episodic
// memories — one per session. No LLM needed (the index already summarizes each
// rollout). Runs on the box. DRY_RUN=true reports without embedding/writing.
//
//   sqlite3 -json state_5.sqlite "SELECT ... FROM threads" > threads.json
//   DRY_RUN=false VOYAGE_API_KEY=… node distill-codex.mjs threads.json
//
// LIVE ingest requires memory-mcp BUILT FIRST (cd ../memory-mcp && npm ci && npm run
// build): rows are written through the shared invariant path
// ../memory-mcp/dist/db/insert-memory.js (content_sha256 + metadata.dupCandidates +
// BOTH embedding columns). DRY_RUN needs no build.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const DRY_RUN = process.env.DRY_RUN !== 'false';
const PROJECT_ID = process.env.PROJECT_ID || 'nodex';
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || '';
const EMBED_MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-4-large';
const CONTEXT_MODEL = process.env.VOYAGE_CONTEXT_MODEL || 'voyage-context-4';
const DATABASE_URL = process.env.DATABASE_URL ||
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.PGHOST || '127.0.0.1'}:5432/${process.env.POSTGRES_DB}`;

const threads = JSON.parse(readFileSync(process.argv[2] || 'threads.json', 'utf8'));

// Shared invariant write path (tech-debt 4761d86c) — content_sha256 + dupCandidates
// flagging (per row, AFTER its vectors are computed) + both embedding columns.
// Loaded only for LIVE runs so DRY_RUN never needs the memory-mcp build.
let insertMemoryRow;
if (!DRY_RUN) {
  try {
    ({ insertMemoryRow } = await import('../memory-mcp/dist/db/insert-memory.js'));
  } catch (e) {
    console.error(`cannot load ../memory-mcp/dist/db/insert-memory.js — build memory-mcp first (cd services/memory-mcp && npm ci && npm run build): ${e.message}`);
    process.exit(1);
  }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const existing = new Set(
  (await pool.query(`SELECT content_sha256 FROM memory.memories WHERE content_sha256 IS NOT NULL`)).rows.map((r) => r.content_sha256),
);

async function embed(text) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], model: EMBED_MODEL, input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

// Contextual embedding for embedding_v2 (voyage-context-3). After the contextual flip,
// searchMemory filters `embedding_v2 IS NOT NULL`, so memories ingested with ONLY the legacy
// `embedding` are invisible to recall until a manual backfill. Compute it here too, the same
// dual-write storeMemory does. One-chunk-per-doc: inputs=[[text]], dim 1024, int8.
// Once the legacy `embedding` column is dropped post burn-in, drop the legacy `embed()` write.
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

let stored = 0, skipped = 0, empty = 0, failed = 0;
for (const th of threads) {
  const titleRaw = (th.title || th.first_user_message || '').trim();
  if (!titleRaw) { empty++; continue; }
  const title = `Codex: ${titleRaw}`.slice(0, 200);
  const content = [
    `Codex session — ${titleRaw}`,
    th.first_user_message ? `First message: ${th.first_user_message}` : '',
    th.preview ? `Preview: ${th.preview}` : '',
    `dir: ${th.cwd || '?'}  branch: ${th.git_branch || '-'}  tokens: ${th.tokens_used || 0}`,
  ].filter(Boolean).join('\n').slice(0, 4000);
  const hash = sha256(content);
  if (existing.has(hash)) { skipped++; continue; }
  if (DRY_RUN) { stored++; continue; }
  const embedInput = `${title}\n${content}`;
  try {
    const vec = await embed(embedInput);
    const vec2 = await embedContextual(embedInput);
    const eventDate = th.created_at ? new Date(th.created_at * 1000).toISOString().slice(0, 10) : null;
    // insertMemoryRow recomputes content_sha256 from the content — same value as
    // `hash` above, so the pre-dedupe set stays coherent.
    await insertMemoryRow(pool, {
      projectId: PROJECT_ID, type: 'episodic', title, content, importance: 0.4,
      metadata: { cwd: th.cwd, branch: th.git_branch, tokens: th.tokens_used, threadId: th.id, tags: ['codex-session'] },
      sourceKind: 'codex-session', eventDate,
    }, { vec, vec2 });
    stored++;
    if (stored % 50 === 0) console.error(`  ${stored} stored...`);
  } catch (e) {
    failed++;
    console.error(`  skip "${title}": ${e.message}`);
    continue;
  }
}
console.error(`codex distill ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}: ${stored} ${DRY_RUN ? 'would-store' : 'stored'}, ${skipped} dedup-skipped, ${empty} empty-title, ${failed} failed`);
await pool.end();
