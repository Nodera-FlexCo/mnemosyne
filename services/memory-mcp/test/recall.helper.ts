// Recall harness for the memory-mcp embedder-flip gate (AC-023/AC-024).
//
// Two layers:
//  1. PURE math — `recallAtK` and `mrr`. These ARE the flip gate's math; a bug here
//     silently passes a bad embedder flip, so they are unit-tested directly against
//     hand-computed values in `recall.helper.test.ts`.
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
