// Pure recall/MRR scoring math for the Wave 5 code embedder bake-off (AC-030/AC-031).
//
// Lives in src/ (not test/) because BOTH the operator-run bake-off module
// (src/db/bakeoff-embed.ts) and the test harness (test/code-eval.helper.ts) need it, and
// tsconfig.json's `rootDir: src` forbids src importing from test. There is NO shared
// package in this repo, so this duplicates memory-mcp's recall.helper.ts math (keyed on
// file PATH here, on memory TITLE there). A bug here silently picks the wrong embedder,
// so it is unit-tested directly against hand-computed values (test/code-eval.helper.test.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** A ranked list of candidate file paths (best-first) returned for one query. */
export type RankedPaths = string[];

/** The set of file paths considered relevant for one query. */
export type RelevantPaths = string[];

/** Normalize a path for comparison: trim, lowercase, strip a leading "./". */
export function normalizePath(p: string): string {
  return p.trim().toLowerCase().replace(/^\.\//, "");
}

function relevantSet(relevant: RelevantPaths): Set<string> {
  return new Set(relevant.map(normalizePath));
}

/**
 * Recall@k for a single query: 1 if any relevant path appears in the top-k hits, else 0.
 * Edge cases: empty `relevant` -> 0 (conservative); k <= 0 -> 0.
 */
export function recallAtK(
  hits: RankedPaths,
  relevant: RelevantPaths,
  k: number,
): number {
  if (k <= 0 || relevant.length === 0) return 0;
  const rel = relevantSet(relevant);
  return hits.slice(0, k).some((h) => rel.has(normalizePath(h))) ? 1 : 0;
}

/**
 * Reciprocal rank for a single query: 1 / (1-based rank of the first relevant hit), or 0
 * when no relevant path appears (or inputs are empty). MRR is the mean over a query set.
 */
export function mrr(hits: RankedPaths, relevant: RelevantPaths): number {
  if (relevant.length === 0) return 0;
  const rel = relevantSet(relevant);
  for (let i = 0; i < hits.length; i++) {
    if (rel.has(normalizePath(hits[i]))) return 1 / (i + 1);
  }
  return 0;
}

/** Mean of `recallAtK` across many queries (the corpus-level Recall@k). */
export function meanRecallAtK(
  perQuery: { hits: RankedPaths; relevant: RelevantPaths }[],
  k: number,
): number {
  if (perQuery.length === 0) return 0;
  return (
    perQuery.reduce((acc, q) => acc + recallAtK(q.hits, q.relevant, k), 0) /
    perQuery.length
  );
}

/** Mean reciprocal rank across many queries. */
export function meanReciprocalRank(
  perQuery: { hits: RankedPaths; relevant: RelevantPaths }[],
): number {
  if (perQuery.length === 0) return 0;
  return (
    perQuery.reduce((acc, q) => acc + mrr(q.hits, q.relevant), 0) /
    perQuery.length
  );
}

/** First relevant rank (1-based) in a ranked list, or null. Shared by both runners. */
export function firstRelevantRank(
  hits: RankedPaths,
  relevant: RelevantPaths,
): number | null {
  const rel = relevantSet(relevant);
  for (let i = 0; i < hits.length; i++) {
    if (rel.has(normalizePath(hits[i]))) return i + 1;
  }
  return null;
}

export interface CodeEvalRow {
  query: string;
  /** Relevant file path(s). A hit on ANY of these in the top-k counts as recall. */
  relevantPaths: RelevantPaths;
  /** Optional human-readable label / archetype for the query (ignored by the loader). */
  archetype?: string;
}

export interface CodeEvalFile {
  _seed?: boolean;
  k: number;
  rows: CodeEvalRow[];
}

export interface CodeRecallEvalResult {
  recallAtK: number;
  mrr: number;
  perQuery: { query: string; rank: number | null; recall: number }[];
}

/**
 * Load + shape the bake-off eval fixture. The fixture lives in test/fixtures/code-eval.json;
 * `test/` is a sibling of both `src/` (under tsx) and `dist/` (compiled), so the default
 * "../test/fixtures/..." resolves in both. Callers may pass an explicit path.
 */
export function loadCodeEval(
  path = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "test",
    "fixtures",
    "code-eval.json",
  ),
): CodeEvalFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CodeEvalFile;
  if (!Array.isArray(raw.rows) || typeof raw.k !== "number") {
    throw new Error("code-eval.json must have { k: number, rows: [...] }");
  }
  return raw;
}
