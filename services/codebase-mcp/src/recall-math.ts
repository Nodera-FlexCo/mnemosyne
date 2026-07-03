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

/**
 * nDCG@k for a single query with BINARY gains (a hit is relevant or it is not — binary
 * suffices for this program's gold sets). DCG = Σ 1/log2(i+1) over relevant hits in the
 * top-k (1-based rank i); IDCG = the ideal DCG for min(|relevant|, k) items; nDCG =
 * DCG/IDCG ∈ [0,1]. Keyed on normalized paths here (stable ids after the wave-2 key
 * switch — the function is key-agnostic strings). This IS the regression-gate metric;
 * a bug here silently green-lights a bad flip. Edge cases mirror `recallAtK`: empty
 * `relevant` -> 0, k <= 0 -> 0.
 */
export function ndcgAtK(
  hits: RankedPaths,
  relevant: RelevantPaths,
  k: number,
): number {
  if (k <= 0 || relevant.length === 0) return 0;
  const rel = relevantSet(relevant);
  let dcg = 0;
  const topK = hits.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    // 1-based rank = i+1 → gain discount 1/log2(rank+1) = 1/log2(i+2)
    if (rel.has(normalizePath(topK[i]))) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const idealCount = Math.min(rel.size, k);
  for (let i = 0; i < idealCount; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Tiny seeded PRNG (mulberry32) so the bootstrap below is DETERMINISTIC under a fixed
 * seed (AC-103) — a gate that flickers across runs is not a gate.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolation percentile of a SORTED ascending array (numpy type-7). */
function percentileSorted(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Percentile paired bootstrap over PER-QUERY metric deltas. Sign convention:
 * delta = candidate − baseline (positive = candidate wins). Resamples
 * `deltas.length` values with replacement `iterations` times using the seeded PRNG,
 * records each resample mean, and returns the observed mean plus the percentile CI
 * (default 95% → 2.5th/97.5th). Deterministic for a fixed seed. Empty input → zeros.
 */
export function pairedBootstrapCI(
  deltas: number[],
  opts: { iterations?: number; seed?: number; level?: number } = {},
): { mean: number; ciLow: number; ciHigh: number } {
  if (deltas.length === 0) return { mean: 0, ciLow: 0, ciHigh: 0 };
  const iterations = opts.iterations ?? 10_000;
  const level = opts.level ?? 0.95;
  const rnd = mulberry32(opts.seed ?? 42);
  const n = deltas.length;
  const mean = deltas.reduce((a, b) => a + b, 0) / n;
  const means = new Array<number>(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += deltas[Math.floor(rnd() * n)];
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    mean,
    ciLow: percentileSorted(means, alpha),
    ciHigh: percentileSorted(means, 1 - alpha),
  };
}

/**
 * Gate semantics (AC-105): the regression side is excluded-zero when the WHOLE CI sits
 * below zero — i.e. the candidate is statistically-significantly worse. With
 * delta = candidate − baseline, that is `ciHigh < 0`.
 */
export function regressionExcluded(ci: {
  ciLow: number;
  ciHigh: number;
}): boolean {
  return ci.ciHigh < 0;
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
