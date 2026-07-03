// Recall harness for the memory-mcp embedder-flip gate (AC-023/AC-024).
//
// Two layers:
//  1. PURE math — `recallAtK`, `mrr`, and the Wave-1 eval additions `ndcgAtK` +
//     `pairedBootstrapCI` (+ `mulberry32`, `regressionExcluded`). These ARE the
//     flip/regression gates' math; a bug here silently passes a bad flip, so they are
//     unit-tested directly against hand-computed values in `recall.helper.test.ts`.
//  2. A thin DB-backed runner — `runRecallEval` — that calls the real `searchMemory`
//     for each seed query and scores the ranked titles. It needs loopback Postgres
//     and a Voyage key (it embeds the query), so callers guard it with
//     `describe.skipIf(!process.env.DATABASE_URL)`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** A ranked list of candidate titles (best-first) returned for one query. */
export type RankedTitles = string[];

/** The set of titles considered relevant for one query. */
export type RelevantTitles = string[];

function normalize(title: string): string {
  return title.trim().toLowerCase();
}

function relevantSet(relevant: RelevantTitles): Set<string> {
  return new Set(relevant.map(normalize));
}

/**
 * Recall@k for a single query: 1 if any relevant title appears in the top-k hits,
 * else 0. (Binary "did we surface a relevant result in the top-k" — the gate we care
 * about for a small held-out set; average across queries for the corpus number.)
 *
 * Edge cases: empty `relevant` -> 0 (nothing to recall, conservative); k <= 0 -> 0.
 */
export function recallAtK(
  hits: RankedTitles,
  relevant: RelevantTitles,
  k: number,
): number {
  if (k <= 0 || relevant.length === 0) return 0;
  const rel = relevantSet(relevant);
  const topK = hits.slice(0, k);
  return topK.some((h) => rel.has(normalize(h))) ? 1 : 0;
}

/**
 * Reciprocal rank for a single query: 1 / (rank of the first relevant hit), ranks
 * 1-based. Returns 0 when no relevant title appears anywhere in `hits` (or inputs are
 * empty). MRR over a query set is the mean of these per-query reciprocal ranks.
 */
export function mrr(hits: RankedTitles, relevant: RelevantTitles): number {
  if (relevant.length === 0) return 0;
  const rel = relevantSet(relevant);
  for (let i = 0; i < hits.length; i++) {
    if (rel.has(normalize(hits[i]))) return 1 / (i + 1);
  }
  return 0;
}

/** Mean of `recallAtK` across many queries (the corpus-level Recall@k). */
export function meanRecallAtK(
  perQuery: { hits: RankedTitles; relevant: RelevantTitles }[],
  k: number,
): number {
  if (perQuery.length === 0) return 0;
  const sum = perQuery.reduce(
    (acc, q) => acc + recallAtK(q.hits, q.relevant, k),
    0,
  );
  return sum / perQuery.length;
}

/** Mean reciprocal rank across many queries. */
export function meanReciprocalRank(
  perQuery: { hits: RankedTitles; relevant: RelevantTitles }[],
): number {
  if (perQuery.length === 0) return 0;
  const sum = perQuery.reduce((acc, q) => acc + mrr(q.hits, q.relevant), 0);
  return sum / perQuery.length;
}

/**
 * nDCG@k for a single query with BINARY gains (a hit is relevant or it is not — binary
 * suffices for this program's gold sets). DCG = Σ 1/log2(i+1) over relevant hits in the
 * top-k (1-based rank i); IDCG = the ideal DCG for min(|relevant|, k) items; nDCG =
 * DCG/IDCG ∈ [0,1]. Key-agnostic: compares normalized strings, so it works on titles
 * today and stable ids after the wave-2 key switch. This IS the regression-gate metric;
 * a bug here silently passes a bad flip. Edge cases mirror `recallAtK`: empty
 * `relevant` -> 0, k <= 0 -> 0.
 */
export function ndcgAtK(
  hits: RankedTitles,
  relevant: RelevantTitles,
  k: number,
): number {
  if (k <= 0 || relevant.length === 0) return 0;
  const rel = relevantSet(relevant);
  let dcg = 0;
  const topK = hits.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    // 1-based rank = i+1 → gain discount 1/log2(rank+1) = 1/log2(i+2)
    if (rel.has(normalize(topK[i]))) dcg += 1 / Math.log2(i + 2);
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

export interface RecallEvalRow {
  query: string;
  relevantTitles: RelevantTitles;
}

export interface RecallEvalFile {
  _seed?: boolean;
  k: number;
  rows: RecallEvalRow[];
}

/** Load + shape the seed eval file. Path defaults to the fixture next to this file. */
export function loadRecallEval(
  path = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "recall-eval.json",
  ),
): RecallEvalFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RecallEvalFile;
  if (!Array.isArray(raw.rows) || typeof raw.k !== "number") {
    throw new Error("recall-eval.json must have { k: number, rows: [...] }");
  }
  return raw;
}

export interface RecallEvalResult {
  recallAtK: number;
  mrr: number;
  perQuery: { query: string; rank: number | null; recall: number }[];
}

/**
 * DB-backed runner: embeds + searches each seed query via the live `searchMemory`,
 * then scores the ranked titles against `relevantTitles`. Requires DATABASE_URL +
 * VOYAGE_API_KEY. `searchMemory` is imported lazily so the pure-function tests do not
 * pull in the pg pool / Voyage client when no DB is configured.
 */
export async function runRecallEval(
  evalFile: RecallEvalFile,
  opts: { projectId: string; limit?: number },
): Promise<RecallEvalResult> {
  const { searchMemory } = await import("../src/memory.js");
  const k = evalFile.k;
  const limit = opts.limit ?? Math.max(k, 10);

  const perQuery: {
    hits: RankedTitles;
    relevant: RelevantTitles;
    query: string;
  }[] = [];
  for (const row of evalFile.rows) {
    const hits = await searchMemory({
      projectId: opts.projectId,
      query: row.query,
      limit,
    });
    perQuery.push({
      query: row.query,
      hits: hits.map((h) => h.title),
      relevant: row.relevantTitles,
    });
  }

  return {
    recallAtK: meanRecallAtK(perQuery, k),
    mrr: meanReciprocalRank(perQuery),
    perQuery: perQuery.map((q) => {
      const rel = relevantSet(q.relevant);
      let rank: number | null = null;
      for (let i = 0; i < q.hits.length; i++) {
        if (rel.has(normalize(q.hits[i]))) {
          rank = i + 1;
          break;
        }
      }
      return { query: q.query, rank, recall: recallAtK(q.hits, q.relevant, k) };
    }),
  };
}
