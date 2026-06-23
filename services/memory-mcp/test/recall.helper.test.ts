import { describe, expect, it } from "vitest";
import {
  loadRecallEval,
  meanRecallAtK,
  meanReciprocalRank,
  mrr,
  recallAtK,
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

// DB-backed runner — needs loopback Postgres + Voyage key (it embeds queries).
// Skipped without DATABASE_URL so the pure-function gate above runs in CI without infra.
describe.skipIf(!process.env.DATABASE_URL)("runRecallEval (DB-backed)", () => {
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
