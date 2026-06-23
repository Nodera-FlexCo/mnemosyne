// Graph traversal (Wave 4, Phase 1e). Walks codebase.symbol_edges with a WITH RECURSIVE
// CTE and returns structured rows for code_graph_expand / code_symbol_lookup /
// code_trace_path. Pattern mirrors search.ts: typed result rows + a single pool.query of a
// WITH-CTE SQL string + a formatter, no ORM.
//
// The graph is BY-NAME resolved (Wave 3): a call edge whose target name matched >1 symbol
// in the repo fans out to one symbol_edges row per candidate. Such targets are AMBIGUOUS
// (AC-010) — detected here as a (from_symbol, target name) group with >1 distinct to_symbol
// among call edges — and the tool layer renders "(name-matched, may be ambiguous)".
//
// Bounds (AC-008): depth default 4, HARD cap 10 (clamped server-side BEFORE building SQL —
// never interpolate an unclamped client value), limit default 50. The cycle guard is a
// per-path uuid[] accumulator: a hop into a symbol already on the current path is rejected,
// so the A↔B fixture cycle terminates instead of looping forever.

import { pool } from "../db/pool.js";

export type Direction = "callees" | "callers" | "both";

export interface GraphRow {
  id: string;
  name: string;
  file: string; // file_path
  line: number; // start_line
  depth: number; // 0 = seed (def)
  edge_type: string; // 'def' | 'call' | 'import' (+ direction for non-seed rows)
  ambiguous: boolean; // true => the hop into this row was a name-matched (>1 candidate) edge
}

export const DEFAULT_DEPTH = 4;
export const MAX_DEPTH = 10;
export const DEFAULT_LIMIT = 50;

/** Clamp a client-supplied depth into [1, MAX_DEPTH]; default when unset/NaN. */
export function clampDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isFinite(depth)) return DEFAULT_DEPTH;
  const d = Math.trunc(depth);
  if (d < 1) return 1;
  if (d > MAX_DEPTH) return MAX_DEPTH;
  return d;
}

/** Clamp a client-supplied limit into [1, 1000]; default when unset/NaN. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const l = Math.trunc(limit);
  if (l < 1) return 1;
  if (l > 1000) return 1000;
  return l;
}

export interface SeedInput {
  projectId: string;
  repo?: string;
  symbolId?: string;
  name?: string;
  file?: string;
  line?: number;
  chunkId?: string;
}

/**
 * Resolve a seed to one or more symbol ids (a name may match many; def returns all).
 * Order of precedence: explicit symbolId > name > chunkId > file(+line).
 * Returns [] when nothing resolves (the tool layer then does the file-read fallback).
 */
export async function resolveSeed(seed: SeedInput): Promise<GraphRow[]> {
  if (seed.symbolId) {
    const { rows } = await pool.query<SymbolLite>(
      `SELECT id, name, file_path, start_line FROM codebase.symbols
       WHERE id = $1 ${seed.repo ? "AND repository_id = $2" : ""}`,
      seed.repo ? [seed.symbolId, seed.repo] : [seed.symbolId],
    );
    return rows.map(toDefRow);
  }

  if (seed.name) {
    const params: unknown[] = [seed.projectId, seed.name];
    let filt = "";
    if (seed.repo) {
      params.push(seed.repo);
      filt = `AND repository_id = $${params.length}`;
    }
    const { rows } = await pool.query<SymbolLite>(
      `SELECT id, name, file_path, start_line FROM codebase.symbols
       WHERE project_id = $1 AND name = $2 ${filt}
       ORDER BY file_path, start_line`,
      params,
    );
    return rows.map(toDefRow);
  }

  if (seed.chunkId) {
    const { rows } = await pool.query<{
      file_path: string;
      start_line: number;
      repository_id: string;
    }>(
      `SELECT file_path, start_line, repository_id FROM codebase.code_chunks WHERE id = $1`,
      [seed.chunkId],
    );
    if (rows.length === 0) return [];
    const c = rows[0];
    return enclosingSymbol(
      seed.projectId,
      seed.repo ?? c.repository_id,
      c.file_path,
      c.start_line,
    );
  }

  if (seed.file) {
    return enclosingSymbol(
      seed.projectId,
      seed.repo,
      seed.file,
      seed.line ?? Number.MAX_SAFE_INTEGER,
    );
  }

  return [];
}

interface SymbolLite {
  id: string;
  name: string;
  file_path: string;
  start_line: number;
}

function toDefRow(r: SymbolLite): GraphRow {
  return {
    id: r.id,
    name: r.name,
    file: r.file_path,
    line: r.start_line,
    depth: 0,
    edge_type: "def",
    ambiguous: false,
  };
}

/** The symbol whose declaration most closely precedes `line` in `file` (the enclosing def). */
async function enclosingSymbol(
  projectId: string,
  repo: string | undefined,
  file: string,
  line: number,
): Promise<GraphRow[]> {
  const params: unknown[] = [projectId, file, line];
  let filt = "";
  if (repo) {
    params.push(repo);
    filt = `AND repository_id = $${params.length}`;
  }
  const { rows } = await pool.query<SymbolLite>(
    `SELECT id, name, file_path, start_line FROM codebase.symbols
     WHERE project_id = $1 AND file_path = $2 AND start_line <= $3 ${filt}
     ORDER BY start_line DESC
     LIMIT 1`,
    params,
  );
  // No symbol declared at/above the line (e.g. file-level code) — fall back to the
  // file's first symbol so a file/chunk seed still anchors the graph somewhere useful.
  if (rows.length === 0) {
    const firstParams: unknown[] = [projectId, file];
    let firstFilt = "";
    if (repo) {
      firstParams.push(repo);
      firstFilt = `AND repository_id = $${firstParams.length}`;
    }
    const { rows: first } = await pool.query<SymbolLite>(
      `SELECT id, name, file_path, start_line FROM codebase.symbols
       WHERE project_id = $1 AND file_path = $2 ${firstFilt}
       ORDER BY start_line ASC
       LIMIT 1`,
      firstParams,
    );
    return first.map(toDefRow);
  }
  return rows.map(toDefRow);
}

interface TraverseRow {
  id: string;
  name: string;
  file_path: string;
  start_line: number;
  depth: number;
  edge_type: string;
  ambiguous: boolean;
}

/**
 * Expand the graph from a set of seed symbol ids along call edges. `direction` controls
 * which way call edges are followed; `both` returns the union of callers + callees over
 * the seeds (the def rows are supplied by the caller via resolveSeed and prepended).
 *
 * The recursive CTE carries a uuid[] path for the cycle guard and a depth counter. We use
 * UNION ALL + the path-array guard (not UNION) so each acyclic path keeps its own depth.
 */
export async function expand(
  seedIds: string[],
  direction: Direction,
  depth: number,
  limit: number,
): Promise<GraphRow[]> {
  if (seedIds.length === 0) return [];
  const maxDepth = clampDepth(depth);
  const lim = clampLimit(limit);

  // Build the recursive walk for one direction. `call` edges only — import edges over-connect
  // (every symbol in an importing file links to the imported one) and would swamp a call trace.
  // callees: follow from_symbol -> to_symbol. callers: follow to_symbol -> from_symbol.
  const buildWalk = (dir: "callees" | "callers"): string => {
    const join =
      dir === "callees" ? "e.from_symbol = w.id" : "e.to_symbol = w.id";
    const nextId = dir === "callees" ? "e.to_symbol" : "e.from_symbol";
    const label = dir === "callees" ? "call→" : "call←";
    return `
      SELECT ${nextId} AS id, w.depth + 1 AS depth, w.path || ${nextId} AS path,
             '${label}'::text AS edge_type
      FROM walk w
      JOIN codebase.symbol_edges e ON ${join}
      WHERE e.kind = 'call'
        AND w.depth < ${maxDepth}
        AND NOT (${nextId} = ANY(w.path))`;
  };

  const recursiveTerms: string[] = [];
  if (direction === "callees" || direction === "both") {
    recursiveTerms.push(buildWalk("callees"));
  }
  if (direction === "callers" || direction === "both") {
    recursiveTerms.push(buildWalk("callers"));
  }

  const sql = `
    WITH RECURSIVE seeds(id) AS (
      SELECT unnest($1::uuid[])
    ),
    walk(id, depth, path, edge_type) AS (
      SELECT s.id, 0, ARRAY[s.id], 'def'::text FROM seeds s
      UNION ALL
      ${recursiveTerms.join("\n      UNION ALL\n")}
    ),
    -- shallowest reach per symbol (a symbol reachable by several paths shows its min depth).
    reached AS (
      SELECT id, min(depth) AS depth,
             (array_agg(edge_type ORDER BY depth))[1] AS edge_type
      FROM walk
      GROUP BY id
    ),
    -- ambiguity (AC-010): a call hop whose target NAME matched >1 distinct symbol from the
    -- same caller. First find the ambiguous (from_symbol, target name) groups, then project
    -- each member to_symbol id — those targets were name-matched and must be labeled.
    amb_groups AS (
      SELECT e.from_symbol, st.name AS to_name
      FROM codebase.symbol_edges e
      JOIN codebase.symbols st ON st.id = e.to_symbol
      WHERE e.kind = 'call'
      GROUP BY e.from_symbol, st.name
      HAVING count(DISTINCT e.to_symbol) > 1
    ),
    amb AS (
      SELECT DISTINCT e.to_symbol AS to_id
      FROM codebase.symbol_edges e
      JOIN codebase.symbols st ON st.id = e.to_symbol
      JOIN amb_groups g
        ON g.from_symbol = e.from_symbol AND g.to_name = st.name
      WHERE e.kind = 'call'
    )
    SELECT s.id, s.name, s.file_path, s.start_line, r.depth, r.edge_type,
           EXISTS (SELECT 1 FROM amb WHERE amb.to_id = s.id AND r.depth > 0) AS ambiguous
    FROM reached r
    JOIN codebase.symbols s ON s.id = r.id
    ORDER BY r.depth, s.file_path, s.start_line
    LIMIT ${lim}`;

  const { rows } = await pool.query<TraverseRow>(sql, [seedIds]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    file: r.file_path,
    line: r.start_line,
    depth: r.depth,
    edge_type: r.edge_type,
    ambiguous: r.ambiguous,
  }));
}

/**
 * code_graph_expand core: resolve a seed, then return def + callers + callees (or one
 * direction). Returns [] when the seed resolves to no symbol (the tool then file-reads).
 */
export async function graphExpand(input: {
  seed: SeedInput;
  direction?: Direction;
  depth?: number;
  limit?: number;
}): Promise<GraphRow[]> {
  const defRows = await resolveSeed(input.seed);
  if (defRows.length === 0) return [];
  const seedIds = defRows.map((d) => d.id);
  return expand(
    seedIds,
    input.direction ?? "both",
    clampDepth(input.depth),
    clampLimit(input.limit),
  );
}

/**
 * code_trace_path core: a directed callees-only chain from a seed. When `toName` is given,
 * stop at the first symbol with that name and return the resolved path to it (approximate —
 * by-name edges make "shortest" non-unique; we return A path, not a proven-unique one).
 */
export async function tracePath(input: {
  seed: SeedInput;
  toName?: string;
  depth?: number;
}): Promise<{ rows: GraphRow[]; reachedTo: boolean }> {
  const defRows = await resolveSeed(input.seed);
  if (defRows.length === 0) return { rows: [], reachedTo: false };
  const seedIds = defRows.map((d) => d.id);
  const rows = await expand(
    seedIds,
    "callees",
    clampDepth(input.depth),
    DEFAULT_LIMIT,
  );
  if (!input.toName) return { rows, reachedTo: false };
  // Truncate the (depth-ordered) chain at the first row matching the target name.
  const idx = rows.findIndex((r) => r.name === input.toName);
  if (idx === -1) return { rows, reachedTo: false };
  return { rows: rows.slice(0, idx + 1), reachedTo: true };
}

/** code_symbol_lookup core: resolve a name to its definition(s), repo+project scoped. */
export async function lookupSymbol(input: {
  projectId: string;
  name: string;
  repo?: string;
  limit?: number;
}): Promise<{ name: string; kind: string; file: string; line: number }[]> {
  const params: unknown[] = [input.projectId, input.name];
  let filt = "";
  if (input.repo) {
    params.push(input.repo);
    filt = `AND repository_id = $${params.length}`;
  }
  const lim = clampLimit(input.limit);
  const { rows } = await pool.query<{
    name: string;
    kind: string;
    file_path: string;
    start_line: number;
  }>(
    `SELECT name, kind, file_path, start_line FROM codebase.symbols
     WHERE project_id = $1 AND name = $2 ${filt}
     ORDER BY file_path, start_line
     LIMIT ${lim}`,
    params,
  );
  return rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    file: r.file_path,
    line: r.start_line,
  }));
}

/** Render graph rows as compact text for the MCP tool response. */
export function formatGraphRows(rows: GraphRow[]): string {
  if (rows.length === 0) return "No graph rows.";
  return rows
    .map((r) => {
      const amb = r.ambiguous ? " (name-matched, may be ambiguous)" : "";
      const indent = "  ".repeat(r.depth);
      return `${indent}[d${r.depth} ${r.edge_type}] ${r.name}  ${r.file}:${r.line}${amb}  [${r.id}]`;
    })
    .join("\n");
}
