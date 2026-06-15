import { pool } from './db/pool.js';
import { embedCode, rerank, toVectorLiteral } from './voyage.js';
import { config } from './config.js';

export interface CodeHit {
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  language: string | null;
  snippet: string;
  score: number;
}

interface Row {
  id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  symbol_name: string | null;
  language: string | null;
  content: string;
  rrf: number;
}

const RECALL_LIMIT = 50;

export async function searchCode(input: {
  projectId: string;
  query: string;
  repo?: string;
  language?: string;
  k: number;
}): Promise<CodeHit[]> {
  const [qvec] = await embedCode([input.query], 'query');
  const params: unknown[] = [input.query, toVectorLiteral(qvec), input.projectId, config.candidatePool];
  let filt = '';
  if (input.repo) { params.push(input.repo); filt += ` AND c.repository_id = $${params.length}`; }
  if (input.language) { params.push(input.language); filt += ` AND c.language = $${params.length}`; }

  const sql = `
    WITH q AS (SELECT plainto_tsquery('english', $1) AS tsq),
    bm25 AS (
      SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.search_tsv, q.tsq) DESC) AS rank
      FROM codebase.code_chunks c, q
      WHERE c.project_id = $3 AND c.search_tsv @@ q.tsq ${filt}
      LIMIT ${RECALL_LIMIT}
    ),
    vec AS (
      SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $2::halfvec) AS rank
      FROM codebase.code_chunks c
      WHERE c.project_id = $3 AND c.embedding IS NOT NULL ${filt}
      ORDER BY c.embedding <=> $2::halfvec
      LIMIT ${RECALL_LIMIT}
    )
    SELECT c.id, c.file_path, c.start_line, c.end_line, c.symbol_name, c.language, c.content,
           COALESCE(1.0/(60+bm25.rank),0) + COALESCE(1.0/(60+vec.rank),0) AS rrf
    FROM codebase.code_chunks c
    LEFT JOIN bm25 ON bm25.id = c.id
    LEFT JOIN vec  ON vec.id  = c.id
    WHERE bm25.id IS NOT NULL OR vec.id IS NOT NULL
    ORDER BY rrf DESC
    LIMIT $4`;

  const { rows } = await pool.query<Row>(sql, params);
  if (rows.length === 0) return [];

  const docs = rows.map((r) => `${r.file_path}\n${r.content}`.slice(0, 1500));
  const ranked = await rerank(input.query, docs, rows.length);
  const order = ranked.length ? ranked : rows.map((_, i) => ({ index: i, score: 0 }));

  return order.slice(0, input.k).map(({ index, score }) => {
    const r = rows[index];
    return {
      chunkId: r.id,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      symbolName: r.symbol_name,
      language: r.language,
      snippet: r.content.split('\n').slice(0, 4).join('\n').slice(0, 240),
      score: Number(score.toFixed(4)),
    };
  });
}

export function formatHits(hits: CodeHit[]): string {
  if (hits.length === 0) return 'No matching code.';
  return hits
    .map(
      (h, i) =>
        `${i + 1}. ${h.filePath}:${h.startLine}-${h.endLine}${h.symbolName ? ` (${h.symbolName})` : ''}  [${h.chunkId}]\n   ${h.snippet.replace(/\n/g, ' ⏎ ')}`,
    )
    .join('\n');
}
