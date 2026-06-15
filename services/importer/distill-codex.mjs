#!/usr/bin/env node
// Ingest the Codex CLI session index (state_5.sqlite -> threads.json) as episodic
// memories — one per session. No LLM needed (the index already summarizes each
// rollout). Runs on the box. DRY_RUN=true reports without embedding/writing.
//
//   sqlite3 -json state_5.sqlite "SELECT ... FROM threads" > threads.json
//   DRY_RUN=false VOYAGE_API_KEY=… node distill-codex.mjs threads.json

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const DRY_RUN = process.env.DRY_RUN !== 'false';
const PROJECT_ID = process.env.PROJECT_ID || 'nodex';
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL ||
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.PGHOST || '127.0.0.1'}:5432/${process.env.POSTGRES_DB}`;

const threads = JSON.parse(readFileSync(process.argv[2] || 'threads.json', 'utf8'));
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const existing = new Set(
  (await pool.query(`SELECT content_sha256 FROM memory.memories WHERE content_sha256 IS NOT NULL`)).rows.map((r) => r.content_sha256),
);

async function embed(text) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], model: 'voyage-4-large', input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

let stored = 0, skipped = 0, empty = 0;
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
  const vec = await embed(`${title}\n${content}`);
  const eventDate = th.created_at ? new Date(th.created_at * 1000).toISOString().slice(0, 10) : null;
  await pool.query(
    `INSERT INTO memory.memories
       (project_id,type,title,content,importance,metadata,embedding,status,source_kind,content_sha256,event_date)
     VALUES ($1,'episodic',$2,$3,0.4,$4,$5::halfvec,'active','codex-session',$6,$7)`,
    [PROJECT_ID, title, content,
     JSON.stringify({ cwd: th.cwd, branch: th.git_branch, tokens: th.tokens_used, threadId: th.id, tags: ['codex-session'] }),
     `[${vec.join(',')}]`, hash, eventDate],
  );
  stored++;
  if (stored % 50 === 0) console.error(`  ${stored} stored...`);
}
console.error(`codex distill ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}: ${stored} ${DRY_RUN ? 'would-store' : 'stored'}, ${skipped} dedup-skipped, ${empty} empty-title`);
await pool.end();
