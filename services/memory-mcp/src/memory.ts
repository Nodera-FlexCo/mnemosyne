import { pool } from './db/pool.js';
import { embed, rerank, toVectorLiteral } from './voyage.js';
import { config } from './config.js';

export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'entity';

export interface Hit {
  id: string;
  title: string;
  type: MemoryType;
  snippet: string;
  importance: number;
  score: number;
}

interface CandidateRow {
  id: string;
  title: string;
  content: string;
  type: MemoryType;
  importance: number;
  created_at: Date;
  event_date?: Date | null;
  rrf: number;
}

const RECALL_LIMIT = 50; // per-arm (BM25 / vector) recall before fusion

export async function storeMemory(input: {
  projectId: string;
  type: MemoryType;
  title: string;
  content: string;
  importance?: number;
  metadata?: Record<string, unknown>;
  sourceSessionId?: string;
  sourceKind?: string;
}): Promise<{ id: string; title: string }> {
  const [vec] = await embed([`${input.title}\n${input.content}`], 'document');
  const { rows } = await pool.query<{ id: string; title: string }>(
    `INSERT INTO memory.memories
       (project_id, type, title, content, importance, metadata, source_session_id, source_kind, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::halfvec)
     RETURNING id, title`,
    [
      input.projectId,
      input.type,
      input.title,
      input.content,
      input.importance ?? 0.5,
      JSON.stringify(input.metadata ?? {}),
      input.sourceSessionId ?? null,
      input.sourceKind ?? null,
      toVectorLiteral(vec),
    ],
  );
  return rows[0];
}

export interface MemoryRow {
  id: string;
  title: string;
  type: MemoryType;
  source_kind: string | null;
  status: string;
  importance: number;
  event_date: Date | null;
}

/**
 * Structured enumeration (NOT semantic search) — list/filter memories by
 * source_kind / type / status / tag, newest first, with counts. Powers
 * "list all open tech debts", "which implementations shipped", etc.
 */
export async function listMemories(input: {
  projectId: string;
  sourceKind?: string;
  type?: MemoryType;
  status?: string;
  tag?: string;
  limit: number;
}): Promise<{ rows: MemoryRow[]; total: number; active: number; resolved: number }> {
  const params: unknown[] = [input.projectId];
  let where = `project_id = $1 AND archived_at IS NULL`;
  // default to active unless a specific status (or 'all') is requested
  if (input.status && input.status !== 'all') {
    params.push(input.status);
    where += ` AND COALESCE(status,'active') = $${params.length}`;
  } else if (!input.status) {
    where += ` AND COALESCE(status,'active') = 'active'`;
  }
  if (input.sourceKind) { params.push(input.sourceKind); where += ` AND source_kind = $${params.length}`; }
  if (input.type) { params.push(input.type); where += ` AND type = $${params.length}::memory.memory_type`; }
  if (input.tag) { params.push(input.tag); where += ` AND metadata->'tags' ? $${params.length}`; }

  const listParams = [...params, input.limit];
  const { rows } = await pool.query<MemoryRow>(
    `SELECT id, title, type, source_kind, COALESCE(status,'active') AS status, importance, event_date
     FROM memory.memories WHERE ${where}
     ORDER BY COALESCE(event_date, created_at) DESC
     LIMIT $${listParams.length}`,
    listParams,
  );

  // counts over the same kind filter (ignoring the status filter), for "X open / Y resolved"
  const countParams: unknown[] = [input.projectId];
  let cf = '';
  if (input.sourceKind) { countParams.push(input.sourceKind); cf = `AND source_kind = $${countParams.length}`; }
  if (input.type) { countParams.push(input.type); cf += ` AND type = $${countParams.length}::memory.memory_type`; }
  const c = await pool.query<{ total: string; active: string; resolved: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE COALESCE(status,'active')='active') AS active,
            count(*) FILTER (WHERE status='resolved') AS resolved
     FROM memory.memories WHERE project_id = $1 AND archived_at IS NULL ${cf}`,
    countParams,
  );
  return {
    rows,
    total: Number(c.rows[0].total),
    active: Number(c.rows[0].active),
    resolved: Number(c.rows[0].resolved),
  };
}

export async function searchMemory(input: {
  projectId: string;
  query: string;
  type?: MemoryType;
  limit: number;
}): Promise<Hit[]> {
  const [qvec] = await embed([input.query], 'query');
  const typeFilter = input.type ? 'AND m.type = $5::memory.memory_type' : '';
  const params: unknown[] = [input.query, toVectorLiteral(qvec), input.projectId, config.candidatePool];
  if (input.type) params.push(input.type);

  const sql = `
    WITH q AS (SELECT plainto_tsquery('english', $1) AS tsq),
    bm25 AS (
      SELECT m.id, row_number() OVER (ORDER BY ts_rank_cd(m.search_tsv, q.tsq) DESC) AS rank
      FROM memory.memories m, q
      WHERE m.archived_at IS NULL AND COALESCE(m.status,'active') = 'active' AND m.project_id = $3
        AND m.search_tsv @@ q.tsq ${typeFilter}
      LIMIT ${RECALL_LIMIT}
    ),
    vec AS (
      SELECT m.id, row_number() OVER (ORDER BY m.embedding <=> $2::halfvec) AS rank
      FROM memory.memories m
      WHERE m.archived_at IS NULL AND COALESCE(m.status,'active') = 'active' AND m.project_id = $3
        AND m.embedding IS NOT NULL ${typeFilter}
      ORDER BY m.embedding <=> $2::halfvec
      LIMIT ${RECALL_LIMIT}
    )
    SELECT m.id, m.title, m.content, m.type, m.importance, m.created_at, m.event_date,
           COALESCE(1.0/(60+bm25.rank),0) + COALESCE(1.0/(60+vec.rank),0) AS rrf
    FROM memory.memories m
    LEFT JOIN bm25 ON bm25.id = m.id
    LEFT JOIN vec  ON vec.id  = m.id
    WHERE bm25.id IS NOT NULL OR vec.id IS NOT NULL
    ORDER BY rrf DESC
    LIMIT $4`;

  const { rows } = await pool.query<CandidateRow>(sql, params);
  if (rows.length === 0) return [];

  // Rerank candidate pool, then blend relevance with recency + importance.
  const docs = rows.map((r) => `${r.title}\n${r.content}`.slice(0, 1200));
  const ranked = await rerank(input.query, docs, rows.length);
  const relById = new Map<string, number>();
  for (const r of ranked) relById.set(rows[r.index].id, r.score);

  const now = Date.now();
  const scored = rows.map((r) => {
    const rel = relById.get(r.id) ?? 0;
    const ageDays = (now - new Date(r.event_date ?? r.created_at).getTime()) / 86_400_000;
    const recency = Math.exp(-ageDays / 30);
    const final = 0.7 * rel + 0.2 * recency + 0.1 * r.importance;
    return { r, final };
  });
  scored.sort((a, b) => b.final - a.final);

  return scored.slice(0, input.limit).map(({ r, final }) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    snippet: r.content.replace(/\s+/g, ' ').slice(0, 180),
    importance: r.importance,
    score: Number(final.toFixed(4)),
  }));
}

export async function getMemory(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `UPDATE memory.memories
       SET access_count = access_count + 1, last_accessed_at = now()
     WHERE id = $1
     RETURNING id, project_id, type, title, content, importance, access_count,
               metadata, source_session_id, pinned, created_at, last_accessed_at`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getRecent(input: {
  projectId: string;
  limit: number;
  type?: MemoryType;
}): Promise<Hit[]> {
  const params: unknown[] = [input.projectId, input.limit];
  let typeFilter = '';
  if (input.type) {
    typeFilter = 'AND type = $3::memory.memory_type';
    params.push(input.type);
  }
  const { rows } = await pool.query<CandidateRow>(
    `SELECT id, title, content, type, importance, created_at, 0 AS rrf
     FROM memory.memories
     WHERE archived_at IS NULL AND COALESCE(status,'active') = 'active' AND project_id = $1 ${typeFilter}
     ORDER BY created_at DESC
     LIMIT $2`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    snippet: r.content.replace(/\s+/g, ' ').slice(0, 180),
    importance: r.importance,
    score: 0,
  }));
}

export async function updateMemory(
  id: string,
  fields: { title?: string; content?: string; importance?: number; pinned?: boolean; status?: string },
): Promise<{ id: string } | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (fields.title !== undefined) { sets.push(`title = $${i++}`); params.push(fields.title); }
  if (fields.content !== undefined) { sets.push(`content = $${i++}`); params.push(fields.content); }
  if (fields.importance !== undefined) { sets.push(`importance = $${i++}`); params.push(fields.importance); }
  if (fields.pinned !== undefined) { sets.push(`pinned = $${i++}`); params.push(fields.pinned); }
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); params.push(fields.status); }

  if (fields.title !== undefined || fields.content !== undefined) {
    const cur = await pool.query<{ title: string; content: string }>(
      `SELECT title, content FROM memory.memories WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return null;
    const title = fields.title ?? cur.rows[0].title;
    const content = fields.content ?? cur.rows[0].content;
    const [vec] = await embed([`${title}\n${content}`], 'document');
    sets.push(`embedding = $${i++}::halfvec`); params.push(toVectorLiteral(vec));
  }
  if (sets.length === 0) return { id };
  params.push(id);
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE memory.memories SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, params);
  return rows[0] ?? null;
}

export async function archiveMemory(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE memory.memories SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function getEntity(input: {
  projectId: string;
  nameOrId: string;
}): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `SELECT id, project_id, kind, external_id, name, summary, metadata, created_at, updated_at
     FROM memory.entities
     WHERE project_id = $1 AND (name ILIKE $2 OR id::text = $2)
     ORDER BY updated_at DESC LIMIT 1`,
    [input.projectId, input.nameOrId],
  );
  if (rows.length === 0) return null;
  const entity = rows[0] as { id: string };
  const edges = await pool.query(
    `SELECT e.relation, e.to_id, t.name AS to_name, t.kind AS to_kind
     FROM memory.entity_edges e JOIN memory.entities t ON t.id = e.to_id
     WHERE e.from_id = $1`,
    [entity.id],
  );
  return { ...entity, edges: edges.rows };
}

export function formatHits(hits: Hit[]): string {
  if (hits.length === 0) return 'No matching memories.';
  return hits
    .map((h, i) => `${i + 1}. [${h.type}] ${h.title}  (id: ${h.id})\n   ${h.snippet}`)
    .join('\n');
}
