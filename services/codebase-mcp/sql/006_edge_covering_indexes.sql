-- Covering indexes for symbol_edges traversal (Wave 3, retrieval-improvement program).
-- Both traversal directions get an index-only-scan path keyed on (endpoint, kind) with
-- the opposite endpoint INCLUDEd, so the recursive CTE and the app-side BFS frontier
-- queries (`WHERE kind='call' AND from_symbol = ANY(...)`) never touch the heap.
--
-- NOT built CONCURRENTLY on purpose: migrate.ts runs each file as ONE pool.query
-- (implicit single transaction), where CONCURRENTLY is illegal — and the table is small
-- today, so a plain build is instant. At >1M edges, build replacements by hand instead:
--   CREATE INDEX CONCURRENTLY ... ; DROP INDEX CONCURRENTLY ...
--
-- The single-column 001 indexes (symedge_from / symedge_to) are strict prefixes of the
-- covering ones and therefore redundant — dropped here. Idempotence note: a re-run after
-- 001 recreates them (IF NOT EXISTS) and this file re-drops them; harmless.

CREATE INDEX IF NOT EXISTS symedge_from_kind
  ON codebase.symbol_edges (from_symbol, kind) INCLUDE (to_symbol);
CREATE INDEX IF NOT EXISTS symedge_to_kind
  ON codebase.symbol_edges (to_symbol, kind) INCLUDE (from_symbol);

DROP INDEX IF EXISTS codebase.symedge_from;
DROP INDEX IF EXISTS codebase.symedge_to;
