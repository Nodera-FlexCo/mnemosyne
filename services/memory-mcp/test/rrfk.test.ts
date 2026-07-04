// Wave 4 (retrieval token efficiency) — injectable RRF_K (AC-815). Covers:
//   AC-815 default   — fuseCandidates without rrfK generates SQL byte-identical to an
//                      explicit rrfK: 60 call, with BOTH RRF terms reading `(60+…)`
//                      (pool ordering itself is pinned by search-golden on :5544).
//   AC-815 override  — a finite rrfK > 0 lands in BOTH RRF terms and changes nothing
//                      else in the SQL (byte-level replaceAll assertion).
//   AC-815 guard     — non-finite or ≤ 0 rrfK rejects BEFORE issuing any SQL and
//                      BEFORE spending an embed call (the value is template-
//                      interpolated, so the guard is also injection hygiene).
//
// Fully mocked (voyage module mock + pool.query spy) — no DATABASE_URL needed; the
// suite runs identically with and without a DB. NO live quota.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ embedCalls: 0 }));

vi.mock("../src/voyage.js", () => ({
  embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  embedContextual: async (docs: string[][]) =>
    docs.map((d) => d.map(() => [0.1, 0.2, 0.3])),
  embedContextualSingle: async (texts: string[]) => {
    H.embedCalls += 1;
    return texts.map(() => [0.1, 0.2, 0.3]);
  },
  rerank: async (_query: string, docs: string[], topK: number) =>
    docs.slice(0, topK).map((_, i) => ({ index: i, score: 0.5 })),
  toVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
}));

process.env.VOYAGE_API_KEY ??= "test-key";

import { fuseCandidates } from "../src/memory.js";
import { pool as livePool } from "../src/db/pool.js";

type QueryFn = (...args: unknown[]) => unknown;

describe("injectable rrfK (AC-815)", () => {
  const captured: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured.length = 0;
    H.embedCalls = 0;
    spy = vi
      .spyOn(livePool as unknown as Record<"query", QueryFn>, "query")
      .mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === "string") captured.push(args[0]);
        return Promise.resolve({ rows: [] });
      });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  async function captureSql(rrfK?: number): Promise<string> {
    captured.length = 0;
    await fuseCandidates({ projectId: "rrfk-test", query: "alpha beta", rrfK });
    expect(captured.length).toBe(1);
    return captured[0];
  }

  it("default (no rrfK) — SQL byte-identical to explicit rrfK: 60, both terms (60+…)", async () => {
    const sqlDefault = await captureSql(undefined);
    const sqlSixty = await captureSql(60);
    expect(sqlDefault).toBe(sqlSixty);
    expect(sqlDefault).toContain("COALESCE(1.0/(60+bm25.rank),0)");
    expect(sqlDefault).toContain("COALESCE(1.0/(60+vec.rank),0)");
    // Exactly the two RRF terms carry the k — no other "(60+" in the template.
    expect(sqlDefault.split("(60+").length - 1).toBe(2);
  });

  it.each([20, 120])(
    "override rrfK=%d — both RRF terms use it and NOTHING else changes",
    async (k) => {
      const sqlDefault = await captureSql(undefined);
      const sqlK = await captureSql(k);
      expect(sqlK).toContain(`COALESCE(1.0/(${k}+bm25.rank),0)`);
      expect(sqlK).toContain(`COALESCE(1.0/(${k}+vec.rank),0)`);
      expect(sqlK).toBe(sqlDefault.replaceAll("(60+", `(${k}+`));
    },
  );

  it.each([Number.NaN, Infinity, -Infinity, 0, -5])(
    "invalid rrfK=%s — rejects BEFORE issuing SQL and BEFORE the embed call",
    async (k) => {
      await expect(
        fuseCandidates({ projectId: "rrfk-test", query: "alpha", rrfK: k }),
      ).rejects.toThrow(/invalid rrfK/);
      expect(captured.length).toBe(0);
      expect(H.embedCalls).toBe(0);
    },
  );

  it("valid rrfK still spends exactly one embed when qvec is absent", async () => {
    await captureSql(120);
    expect(H.embedCalls).toBe(1);
  });
});
