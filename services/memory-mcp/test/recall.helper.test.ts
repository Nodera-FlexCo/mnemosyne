import { describe, expect, it } from "vitest";
import {
  loadRecallEval,
  meanRecallAtK,
  meanReciprocalRank,
  mrr,
  mulberry32,
  ndcgAtK,
  pairedBootstrapCI,
  recallAtK,
  regressionExcluded,
  runRecallEval,
} from "./recall.helper.js";
import { config } from "../src/config.js";

describe("recallAtK (gate math)", () => {
  const hits = ["alpha", "beta", "gamma", "delta"];

  it("relevant at rank 1 -> 1", () => {
    expect(recallAtK(hits, ["alpha"], 10)).toBe(1);
  });

  it("relevant at rank 3, k=3 -> 1", () => {
    expect(recallAtK(hits, ["gamma"], 3)).toBe(1);
  });

  it("relevant at rank 3, k=2 -> 0 (outside top-k)", () => {
    expect(recallAtK(hits, ["gamma"], 2)).toBe(0);
  });

  it("not in hits -> 0", () => {
    expect(recallAtK(hits, ["zeta"], 10)).toBe(0);
  });

  it("empty relevant set -> 0", () => {
    expect(recallAtK(hits, [], 10)).toBe(0);
  });

  it("k <= 0 -> 0", () => {
    expect(recallAtK(hits, ["alpha"], 0)).toBe(0);
  });

  it("matches titles case-insensitively and ignores surrounding whitespace", () => {
    expect(recallAtK(["  Alpha  "], ["alpha"], 1)).toBe(1);
  });
});

describe("mrr (gate math)", () => {
  const hits = ["alpha", "beta", "gamma", "delta"];

  it("relevant at rank 1 -> 1.0", () => {
    expect(mrr(hits, ["alpha"])).toBe(1.0);
  });

  it("relevant at rank 2 -> 0.5", () => {
    expect(mrr(hits, ["beta"])).toBe(0.5);
  });

  it("relevant at rank 3 -> 1/3", () => {
    expect(mrr(hits, ["gamma"])).toBeCloseTo(1 / 3, 10);
  });

  it("takes the FIRST relevant hit when several are relevant", () => {
    expect(mrr(hits, ["gamma", "beta"])).toBe(0.5);
  });

  it("absent relevant title -> 0", () => {
    expect(mrr(hits, ["zeta"])).toBe(0);
  });

  it("empty relevant set -> 0", () => {
    expect(mrr(hits, [])).toBe(0);
  });
});

describe("corpus-level aggregates", () => {
  it("meanRecallAtK averages per-query recall", () => {
    const perQuery = [
      { hits: ["a", "b"], relevant: ["a"] }, // 1
      { hits: ["c", "d"], relevant: ["x"] }, // 0
    ];
    expect(meanRecallAtK(perQuery, 10)).toBe(0.5);
  });

  it("meanReciprocalRank averages per-query reciprocal ranks", () => {
    const perQuery = [
      { hits: ["a", "b"], relevant: ["a"] }, // 1
      { hits: ["c", "d"], relevant: ["d"] }, // 0.5
    ];
    expect(meanReciprocalRank(perQuery)).toBeCloseTo(0.75, 10);
  });

  it("empty query set -> 0 for both", () => {
    expect(meanRecallAtK([], 10)).toBe(0);
    expect(meanReciprocalRank([])).toBe(0);
  });
});

// ── Wave-1 eval math (AC-103): every expected value is hand-computed in a comment. ──

describe("ndcgAtK (gate math)", () => {
  const hits = ["alpha", "beta", "gamma", "delta", "epsilon"];

  it("single relevant at rank 1 -> 1.0", () => {
    // DCG = 1/log2(2) = 1; IDCG (1 item) = 1 → 1.0
    expect(ndcgAtK(hits, ["alpha"], 10)).toBe(1);
  });

  it("single relevant at rank 3, k=10 -> 1/log2(4) = 0.5", () => {
    // DCG = 1/log2(3+1) = 0.5; IDCG (1 item) = 1 → 0.5
    expect(ndcgAtK(hits, ["gamma"], 10)).toBeCloseTo(0.5, 10);
  });

  it("two relevant at ranks 2+4, k=10, |relevant|=2", () => {
    // DCG  = 1/log2(3) + 1/log2(5)
    // IDCG = 1/log2(2) + 1/log2(3) = 1 + 1/log2(3)
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
    const idcg = 1 + 1 / Math.log2(3);
    expect(ndcgAtK(hits, ["beta", "delta"], 10)).toBeCloseTo(dcg / idcg, 10);
  });

  it("relevant absent from hits -> 0", () => {
    expect(ndcgAtK(hits, ["zeta"], 10)).toBe(0);
  });

  it("k = 0 -> 0", () => {
    expect(ndcgAtK(hits, ["alpha"], 0)).toBe(0);
  });

  it("empty relevant set -> 0", () => {
    expect(ndcgAtK(hits, [], 10)).toBe(0);
  });

  it("k < |relevant| truncates the IDCG (3 relevant, k=2, hits at ranks 1+2 -> 1.0)", () => {
    // DCG  = 1/log2(2) + 1/log2(3)
    // IDCG = ideal for min(3, 2) = 2 items = the same sum → 1.0
    expect(ndcgAtK(hits, ["alpha", "beta", "zeta"], 2)).toBeCloseTo(1, 10);
  });

  it("relevant outside top-k does not count (relevant at rank 3, k=2 -> 0)", () => {
    expect(ndcgAtK(hits, ["gamma"], 2)).toBe(0);
  });

  it("matches case-insensitively with surrounding whitespace (normalize)", () => {
    expect(ndcgAtK(["  Alpha  "], ["alpha"], 1)).toBe(1);
  });
});

describe("mulberry32 (deterministic PRNG)", () => {
  it("same seed -> same first 5 values", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("values lie in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("pairedBootstrapCI (gate math)", () => {
  it("constant deltas [0.1 x20] -> mean 0.1, ciLow = ciHigh = 0.1", () => {
    // Every resample mean of a constant array is that constant.
    const ci = pairedBootstrapCI(Array(20).fill(0.1), { iterations: 500 });
    expect(ci.mean).toBeCloseTo(0.1, 10);
    expect(ci.ciLow).toBeCloseTo(0.1, 10);
    expect(ci.ciHigh).toBeCloseTo(0.1, 10);
  });

  it("all-negative deltas -> CI below zero -> regressionExcluded true", () => {
    const ci = pairedBootstrapCI(Array(20).fill(-0.05), { iterations: 500 });
    expect(ci.ciHigh).toBeLessThan(0);
    expect(regressionExcluded(ci)).toBe(true);
  });

  it("mixed +/- deltas straddling zero -> regressionExcluded false", () => {
    // Symmetric ±0.1: resample means straddle 0, so the 95% CI contains it.
    const deltas = [0.1, -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1];
    const ci = pairedBootstrapCI(deltas, { iterations: 2000, seed: 7 });
    expect(ci.ciLow).toBeLessThan(0);
    expect(ci.ciHigh).toBeGreaterThan(0);
    expect(regressionExcluded(ci)).toBe(false);
  });

  it("is deterministic: same seed twice -> identical output", () => {
    const deltas = [0.02, -0.01, 0.05, 0.0, -0.03, 0.04, 0.01];
    const a = pairedBootstrapCI(deltas, { iterations: 1000, seed: 99 });
    const b = pairedBootstrapCI(deltas, { iterations: 1000, seed: 99 });
    expect(a).toEqual(b);
  });

  it("empty input -> zeros", () => {
    expect(pairedBootstrapCI([])).toEqual({ mean: 0, ciLow: 0, ciHigh: 0 });
  });

  it("CI brackets the observed mean", () => {
    const deltas = [0.1, 0.2, 0.15, 0.05, 0.3, 0.25, 0.12, 0.18];
    const ci = pairedBootstrapCI(deltas, { iterations: 2000, seed: 3 });
    expect(ci.ciLow).toBeLessThanOrEqual(ci.mean);
    expect(ci.ciHigh).toBeGreaterThanOrEqual(ci.mean);
  });
});

describe("regressionExcluded (gate semantics)", () => {
  it("whole CI below zero -> true (delta = candidate - baseline)", () => {
    expect(regressionExcluded({ ciLow: -0.2, ciHigh: -0.01 })).toBe(true);
  });
  it("CI containing zero -> false", () => {
    expect(regressionExcluded({ ciLow: -0.05, ciHigh: 0.05 })).toBe(false);
  });
  it("whole CI above zero (a win) -> false", () => {
    expect(regressionExcluded({ ciLow: 0.01, ciHigh: 0.2 })).toBe(false);
  });
});

describe("seed eval fixture", () => {
  it("loads and is shaped { k, rows }", () => {
    const ev = loadRecallEval();
    expect(typeof ev.k).toBe("number");
    expect(Array.isArray(ev.rows)).toBe(true);
    expect(ev.rows.length).toBeGreaterThanOrEqual(15);
    for (const row of ev.rows) {
      expect(typeof row.query).toBe("string");
      expect(Array.isArray(row.relevantTitles)).toBe(true);
      expect(row.relevantTitles.length).toBeGreaterThan(0);
    }
  });

  it("is flagged as a seed (must be expanded before the Wave-P flip)", () => {
    const ev = loadRecallEval();
    expect(ev._seed).toBe(true);
  });
});

// DB-backed runner — needs loopback Postgres AND a LIVE Voyage key (it embeds each
// query through the real /embeddings|/contextualizedembeddings endpoint, burning quota).
// Per recall-eval.md it is "run deliberately, not on every CI push", so it is gated on
// an explicit opt-in (`VOYAGE_LIVE_TESTS=1`) in addition to DATABASE_URL — otherwise a
// DB-only run (e.g. the backfill/recall-gate suites) would 401 on a non-live key.
const LIVE =
  !!process.env.DATABASE_URL && process.env.VOYAGE_LIVE_TESTS === "1";
describe.skipIf(!LIVE)("runRecallEval (DB-backed)", () => {
  it("runs searchMemory over the seed set and returns recall + mrr", async () => {
    const ev = loadRecallEval();
    const result = await runRecallEval(ev, {
      projectId: config.defaultProjectId,
    });
    expect(result.recallAtK).toBeGreaterThanOrEqual(0);
    expect(result.recallAtK).toBeLessThanOrEqual(1);
    expect(result.mrr).toBeGreaterThanOrEqual(0);
    expect(result.mrr).toBeLessThanOrEqual(1);
    expect(result.perQuery.length).toBe(ev.rows.length);
  });
});
