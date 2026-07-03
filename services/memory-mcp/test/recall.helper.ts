// Recall harness for the memory-mcp embedder-flip gate (AC-023/AC-024).
//
// Two layers:
//  1. PURE math — `recallAtK`, `mrr`, and the Wave-1 eval additions `ndcgAtK` +
//     `pairedBootstrapCI` (+ `mulberry32`, `regressionExcluded`). These ARE the
//     flip/regression gates' math; a bug here silently passes a bad flip, so they are
//     unit-tested directly against hand-computed values in `recall.helper.test.ts`.
//  2. A DB-backed two-layer runner — `runRecallEval` — that scores v2 (stable-id) gold
//     at BOTH layers of the live pipeline: Recall@25 at `fuseCandidates` (the pool) and
//     nDCG@10 + MRR at the full `searchMemory`, resolving `superseded_by` forward
//     chains so consolidation can never orphan gold (AC-106). It needs loopback
//     Postgres and a (real or mocked) Voyage, so callers guard it with
//     `describe.skipIf(!process.env.DATABASE_URL)`. Run artifacts (AC-104) are written
//     by `writeRunArtifact`; the CI gate joins them per-query via `perQueryDeltas`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 *
 * ONE-CREDIT rule: each relevant key gains at its FIRST occurrence only — canonicalized
 * hit lists can carry the same key twice (e.g. two supersession-chain members mapping to
 * one gold id), and crediting every occurrence lets DCG exceed the IDCG anchor
 * (nDCG > 1), silently biasing the regression gate. This matches `mrr`/`recallAtK`
 * first-occurrence semantics.
 */
export function ndcgAtK(
  hits: RankedTitles,
  relevant: RelevantTitles,
  k: number,
): number {
  if (k <= 0 || relevant.length === 0) return 0;
  const rel = relevantSet(relevant);
  const credited = new Set<string>();
  let dcg = 0;
  const topK = hits.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    // 1-based rank = i+1 → gain discount 1/log2(rank+1) = 1/log2(i+2)
    const key = normalize(topK[i]);
    if (rel.has(key) && !credited.has(key)) {
      credited.add(key);
      dcg += 1 / Math.log2(i + 2);
    }
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

const DEFAULT_EVAL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "recall-eval.json",
);

/** Load + shape the v1 (title-keyed) seed eval file. Kept for the seed-fixture tests
 *  and as `gold:migrate`'s input; the runner below consumes the v2 shape. */
export function loadRecallEval(path = DEFAULT_EVAL_PATH): RecallEvalFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RecallEvalFile;
  if (!Array.isArray(raw.rows) || typeof raw.k !== "number") {
    throw new Error("recall-eval.json must have { k: number, rows: [...] }");
  }
  return raw;
}

// ── v2 gold (stable memory ids + splits, wave-2) ─────────────────────────────────────

export interface RecallEvalRowV2 {
  /** Stable row id ("m-001"…) — the baseline↔fresh gate join key. */
  id: string;
  query: string;
  /** Gold MEMORY ids. Scoring resolves `superseded_by` forward chains (AC-106). */
  relevantIds: string[];
  archetype?: string;
  /** "dev" (CI gate recomputes it) or "test" (spent only by flip gates, AC-109). */
  split: "dev" | "test";
  provenance: "seed-v1" | "distilled" | "log-harvest";
  approvedBy?: string;
}

export interface RecallEvalFileV2 {
  version: 2;
  k: number;
  changelog: string[];
  rows: RecallEvalRowV2[];
}

/**
 * Load the eval file WHEN it has been migrated to v2 (stable-id gold); returns null on
 * a v1 file so callers (the gate, the live runner test) can skip gracefully until the
 * operator approves + renames the `gold:migrate` proposal (AC-109).
 */
export function tryLoadRecallEvalV2(
  path = DEFAULT_EVAL_PATH,
): RecallEvalFileV2 | null {
  const raw = JSON.parse(
    readFileSync(path, "utf8"),
  ) as Partial<RecallEvalFileV2>;
  if (raw.version !== 2) return null;
  if (!Array.isArray(raw.rows) || typeof raw.k !== "number") {
    throw new Error(
      "recall-eval.json v2 must have { version: 2, k, rows: [...] }",
    );
  }
  for (const r of raw.rows) {
    if (
      !r.id ||
      !Array.isArray(r.relevantIds) ||
      (r.split !== "dev" && r.split !== "test")
    ) {
      throw new Error(
        `recall-eval.json v2 rows need id/relevantIds/split (bad row: ${JSON.stringify(r.query)})`,
      );
    }
  }
  return raw as RecallEvalFileV2;
}

/** Rows of one split. */
export function filterRowsBySplit(
  file: RecallEvalFileV2,
  split: "dev" | "test",
): RecallEvalRowV2[] {
  return file.rows.filter((r) => r.split === split);
}

/**
 * Resolve each gold id's supersession FORWARD chain (AC-106): gold id → the set of ids
 * a hit may carry and still count as that gold item (itself + every successor reached
 * via `superseded_by`). Consolidation marks losers superseded — search then returns the
 * WINNER — so without this walk, consolidating a gold-referenced memory would orphan
 * the gold row. Recursive CTE with the path-array cycle guard (decisionChain pattern);
 * ids absent from the DB still resolve to themselves.
 */
export async function resolveGoldIds(
  pool: {
    query: (
      text: string,
      params: unknown[],
    ) => Promise<{ rows: { root: string; id: string }[] }>;
  },
  ids: string[],
): Promise<Map<string, Set<string>>> {
  const chains = new Map<string, Set<string>>();
  for (const id of ids) chains.set(id, new Set([id]));
  if (ids.length === 0) return chains;

  // Forward walk: each chain row carries its own `superseded_by` pointer; the recursive
  // member joins the NEXT row (the successor) on m.id = c.superseded_by.
  const { rows } = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT m.id, m.superseded_by, m.id AS root, ARRAY[m.id] AS path
       FROM memory.memories m
       WHERE m.id = ANY($1::uuid[])
       UNION ALL
       SELECT m.id, m.superseded_by, c.root, c.path || m.id
       FROM memory.memories m
       JOIN chain c ON m.id = c.superseded_by
       WHERE NOT (m.id = ANY(c.path))
     )
     SELECT root, id FROM chain`,
    [ids],
  );
  for (const r of rows) chains.get(r.root)?.add(r.id);
  return chains;
}

/**
 * Canonicalize a ranked id list against the gold chains (AC-106): walk the hits in rank
 * order and let each hit CONSUME one not-yet-credited gold id whose chain contains it.
 * Overlapping chains can converge on one winner (consolidating two gold-referenced
 * memories into the same survivor), so a member may belong to SEVERAL gold ids — a
 * first-wins member→gold map would let a hit on the shared member credit only one fixed
 * gold, orphaning the other even when a separate hit could have stood for it. Hits whose
 * golds are all consumed (or that match no chain) pass through as their raw id, so a
 * duplicate can never credit the same gold twice.
 */
export function canonicalizeRanked(
  ids: string[],
  chains: Map<string, Set<string>>,
): string[] {
  // member -> gold ids whose chain contains it, in `chains` insertion order
  // (= relevantIds order) for determinism.
  const goldsByMember = new Map<string, string[]>();
  for (const [gold, members] of chains) {
    for (const m of members) {
      const list = goldsByMember.get(m);
      if (list) list.push(gold);
      else goldsByMember.set(m, [gold]);
    }
  }
  const credited = new Set<string>();
  return ids.map((id) => {
    for (const gold of goldsByMember.get(id) ?? []) {
      if (!credited.has(gold)) {
        credited.add(gold);
        return gold;
      }
    }
    return id;
  });
}

// ── Two-layer eval runner + artifacts (wave-2, AC-104) ───────────────────────────────

/** Pool-layer Recall@k cutoff (matches `config.candidatePool`'s documented ceiling). */
export const POOL_RECALL_K = 25;
/** Final-layer nDCG/MRR cutoff. */
export const FINAL_NDCG_K = 10;

/** One query's scores across BOTH layers of an eval run. */
export interface RunPerQuery {
  id: string;
  query: string;
  /** Recall@25 at the candidate-pool layer (fuse only — did recall surface gold?). */
  poolRecall: number;
  /** nDCG@10 at the final layer (full pipeline — did rerank+blend order gold well?). */
  ndcg: number;
  /** Reciprocal rank of the first relevant final hit (0 when absent). */
  mrr: number;
  /** 1-based rank of the first relevant final hit, or null. */
  rank: number | null;
}

/**
 * The committed run-artifact payload (AC-104): the FULL retrievalConfig() snapshot plus
 * per-query scores for both layers. `test/runs/baseline-dev.json` is a committed copy
 * of one of these, chosen by the operator at a flip gate.
 */
export interface RunArtifact {
  retrievalConfig: Record<string, unknown>;
  evalVersion: number;
  split: string;
  rows: number;
  perQuery: RunPerQuery[];
  aggregates: { recallAt25: number; ndcgAt10: number; mrr10: number };
}

/**
 * v2 two-layer DB-backed runner (id-keyed gold, supersession-resolved):
 *
 *  - POOL layer — `fuseCandidates` directly; Recall@25 over candidate ids (the reranker
 *    cannot fix recall, so the floor is scored where recall happens).
 *  - FINAL layer — the full `searchMemory` pipeline; nDCG@10 + MRR over hit ids.
 *
 * Hit ids are CANONICALIZED before scoring: a hit on any member of a gold id's forward
 * chain counts as a hit on that gold id (AC-106), so IDCG stays anchored to the number
 * of gold items, not chain lengths. Returns the complete artifact payload
 * (retrievalConfig() snapshot included) ready for `writeRunArtifact`. Requires
 * DATABASE_URL + a (real or mocked) Voyage; `../src/memory.js` is imported lazily so
 * pure tests never pull the pg pool / Voyage client.
 */
export async function runRecallEval(
  evalFile: RecallEvalFileV2,
  opts: {
    projectId: string;
    split?: "dev" | "test";
    /** Pool for gold-chain resolution; defaults to the service's module pool. */
    pool?: {
      query: (
        text: string,
        params: unknown[],
      ) => Promise<{ rows: { root: string; id: string }[] }>;
    };
  },
): Promise<RunArtifact> {
  const { fuseCandidates, searchMemory, retrievalConfig } =
    await import("../src/memory.js");
  const snapshot = retrievalConfig();
  // The pool-layer metric NAME is fixed (Recall@25) while config.candidatePool is
  // env-variable — refuse to record a mislabeled number rather than silently scoring a
  // different cutoff (the cutoff is deliberately NOT dynamic; the metric must stay
  // comparable across runs).
  if (snapshot.candidatePool !== POOL_RECALL_K) {
    throw new Error(
      `pool-recall cutoff mismatch: config.candidatePool = ${snapshot.candidatePool} ` +
        `but the pool metric is fixed at Recall@${POOL_RECALL_K} — unset CANDIDATE_POOL ` +
        `(or restore ${POOL_RECALL_K}) before running the eval.`,
    );
  }
  const pool = opts.pool ?? (await import("../src/db/pool.js")).pool;
  const rows = opts.split
    ? filterRowsBySplit(evalFile, opts.split)
    : evalFile.rows;

  const perQuery: RunPerQuery[] = [];
  for (const row of rows) {
    const chains = await resolveGoldIds(pool, row.relevantIds);
    const canonical = (ids: string[]) => canonicalizeRanked(ids, chains);

    // Layer 1: candidate pool only.
    const cands = await fuseCandidates({
      projectId: opts.projectId,
      query: row.query,
    });
    const poolIds = canonical(cands.map((c) => c.id));
    const poolRecall = recallAtK(poolIds, row.relevantIds, POOL_RECALL_K);

    // Layer 2: the full live pipeline.
    const hits = await searchMemory({
      projectId: opts.projectId,
      query: row.query,
      limit: FINAL_NDCG_K,
    });
    const finalIds = canonical(hits.map((h) => h.id));

    const rel = new Set(row.relevantIds.map(normalize));
    let rank: number | null = null;
    for (let i = 0; i < finalIds.length; i++) {
      if (rel.has(normalize(finalIds[i]))) {
        rank = i + 1;
        break;
      }
    }

    perQuery.push({
      id: row.id,
      query: row.query,
      poolRecall,
      ndcg: ndcgAtK(finalIds, row.relevantIds, FINAL_NDCG_K),
      mrr: mrr(finalIds, row.relevantIds),
      rank,
    });
  }

  const n = perQuery.length;
  const mean = (f: (q: RunPerQuery) => number) =>
    n === 0 ? 0 : perQuery.reduce((a, q) => a + f(q), 0) / n;
  return {
    retrievalConfig: snapshot,
    evalVersion: evalFile.version,
    split: opts.split ?? "all",
    rows: n,
    perQuery,
    aggregates: {
      recallAt25: mean((q) => q.poolRecall),
      ndcgAt10: mean((q) => q.ndcg),
      mrr10: mean((q) => q.mrr),
    },
  };
}

/**
 * Write an eval-run artifact as `<dir>/<ISO-date>-<label>.json` and return the path.
 * Artifacts under `test/runs/` are COMMITTED — they are the baselines the CI gate joins
 * against; tests write to a tmp dir instead so `git status` stays clean.
 */
export function writeRunArtifact(
  dir: string,
  label: string,
  payload: RunArtifact,
): string {
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${date}-${label}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

/**
 * Join a baseline artifact against a fresh run BY ROW ID and return per-query nDCG@10
 * deltas (fresh − baseline, id-sorted). Fails LOUDLY when the id sets differ — a changed
 * dev split invalidates the baseline (the operator re-records it at a flip gate).
 */
export function perQueryDeltas(
  baseline: RunArtifact,
  fresh: RunArtifact,
): number[] {
  const b = new Map(baseline.perQuery.map((q) => [q.id, q]));
  const f = new Map(fresh.perQuery.map((q) => [q.id, q]));
  const missing = [...b.keys()].filter((id) => !f.has(id));
  const extra = [...f.keys()].filter((id) => !b.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `eval-split drift: baseline and fresh run disagree on row ids ` +
        `(missing from fresh: [${missing.join(", ")}]; not in baseline: [${extra.join(", ")}]). ` +
        `A changed dev split invalidates the baseline — re-record it at a flip gate.`,
    );
  }
  return [...b.keys()].sort().map((id) => f.get(id)!.ndcg - b.get(id)!.ndcg);
}
