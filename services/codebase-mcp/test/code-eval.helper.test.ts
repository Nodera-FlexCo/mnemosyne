// Hand-computed unit tests for the bake-off scoring math (AC-030). A silent bug here
// (off-by-one rank, wrong empty-set default, path-normalization slip) would pick the
// wrong embedder with a green-looking number, so the math is tested directly — no DB,
// no Voyage. Also guards the seed eval fixture's shape (≥50 rows, seed flag).

import { describe, expect, it } from "vitest";
import {
  firstRelevantRank,
  loadCodeEval,
  meanRecallAtK,
  meanReciprocalRank,
  mrr,
  normalizePath,
  recallAtK,
} from "./code-eval.helper.js";

describe("normalizePath", () => {
  it("lowercases, trims, and strips a leading ./", () => {
    expect(normalizePath("  ./Src/Auth.TS ")).toBe("src/auth.ts");
  });
  it("leaves an already-normal path unchanged", () => {
    expect(normalizePath("services/codebase-mcp/src/search.ts")).toBe(
      "services/codebase-mcp/src/search.ts",
    );
  });
});

describe("recallAtK (gate math)", () => {
  const hits = ["a/one.ts", "b/two.ts", "c/three.ts", "d/four.ts"];

  it("relevant at rank 1 -> 1", () => {
    expect(recallAtK(hits, ["a/one.ts"], 10)).toBe(1);
  });
  it("relevant at rank 3, k=3 -> 1", () => {
    expect(recallAtK(hits, ["c/three.ts"], 3)).toBe(1);
  });
  it("relevant at rank 3, k=2 -> 0 (outside top-k)", () => {
    expect(recallAtK(hits, ["c/three.ts"], 2)).toBe(0);
  });
  it("not in hits -> 0", () => {
    expect(recallAtK(hits, ["z/none.ts"], 10)).toBe(0);
  });
  it("any of several relevant paths in top-k -> 1", () => {
    expect(recallAtK(hits, ["z/none.ts", "b/two.ts"], 10)).toBe(1);
  });
  it("empty relevant set -> 0 (conservative)", () => {
    expect(recallAtK(hits, [], 10)).toBe(0);
  });
  it("k <= 0 -> 0", () => {
    expect(recallAtK(hits, ["a/one.ts"], 0)).toBe(0);
  });
  it("matches paths case-insensitively and ignores leading ./", () => {
    expect(recallAtK(["  ./A/One.TS  "], ["a/one.ts"], 1)).toBe(1);
  });
});

describe("mrr (gate math)", () => {
  const hits = ["a/one.ts", "b/two.ts", "c/three.ts", "d/four.ts"];

  it("relevant at rank 1 -> 1.0", () => {
    expect(mrr(hits, ["a/one.ts"])).toBe(1.0);
  });
  it("relevant at rank 2 -> 0.5", () => {
    expect(mrr(hits, ["b/two.ts"])).toBe(0.5);
  });
  it("relevant at rank 3 -> 1/3", () => {
    expect(mrr(hits, ["c/three.ts"])).toBeCloseTo(1 / 3, 10);
  });
  it("takes the FIRST relevant hit when several are relevant", () => {
    expect(mrr(hits, ["c/three.ts", "b/two.ts"])).toBe(0.5);
  });
  it("absent relevant path -> 0", () => {
    expect(mrr(hits, ["z/none.ts"])).toBe(0);
  });
  it("empty relevant set -> 0", () => {
    expect(mrr(hits, [])).toBe(0);
  });
});

describe("firstRelevantRank", () => {
  const hits = ["a.ts", "b.ts", "c.ts"];
  it("returns the 1-based rank of the first relevant path", () => {
    expect(firstRelevantRank(hits, ["b.ts"])).toBe(2);
  });
  it("returns null when no relevant path is present", () => {
    expect(firstRelevantRank(hits, ["z.ts"])).toBeNull();
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

describe("seed code-eval fixture (AC-030)", () => {
  it("loads and is shaped { k, rows } with ≥50 rows", () => {
    const ev = loadCodeEval();
    expect(typeof ev.k).toBe("number");
    expect(ev.k).toBe(10); // Recall@10 / MRR@10
    expect(Array.isArray(ev.rows)).toBe(true);
    expect(ev.rows.length).toBeGreaterThanOrEqual(50);
    for (const row of ev.rows) {
      expect(typeof row.query).toBe("string");
      expect(row.query.length).toBeGreaterThan(0);
      expect(Array.isArray(row.relevantPaths)).toBe(true);
      expect(row.relevantPaths.length).toBeGreaterThan(0);
      for (const p of row.relevantPaths) expect(typeof p).toBe("string");
    }
  });

  it("is flagged as a seed (operator must expand + freeze before the AC-030 decision)", () => {
    const ev = loadCodeEval();
    expect(ev._seed).toBe(true);
  });

  it("covers the documented query archetypes", () => {
    const ev = loadCodeEval();
    const archetypes = new Set(ev.rows.map((r) => r.archetype).filter(Boolean));
    for (const a of [
      "where-is-X",
      "how-do-we-X",
      "symbol-lookup",
      "route-to-handler",
      "cross-file-usage",
    ]) {
      expect(archetypes.has(a)).toBe(true);
    }
  });
});
