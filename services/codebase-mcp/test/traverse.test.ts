// Wave 4 — traversal CTE correctness (AC-008/010). Indexes the golden sample-repo into the
// test DB, then exercises traverse.ts directly: the route→handler→service→repo callees chain
// at depth 1/2/4 matches graph-fixture.md; the A↔B cycle terminates (path-array guard); depth
// is clamped to the hard cap; limit is honored; the ambiguous `format` target is flagged.
// Requires DATABASE_URL (skipIf otherwise).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const sampleRepoDir = join(here, "fixtures", "sample-repo");
const REPO = "traverse-test";
const PROJ = "traverse-proj";

// Hermetic embedder (no Voyage key/quota) — one deterministic 1024-dim vector per chunk.
vi.mock("../src/voyage.js", () => ({
  embedCode: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.001)),
  ),
  toVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
}));

const { indexRepo } = await import("../src/indexer.js");
const {
  graphExpand,
  tracePath,
  lookupSymbol,
  resolveSeed,
  clampDepth,
  clampLimit,
  MAX_DEPTH,
  DEFAULT_DEPTH,
  DEFAULT_LIMIT,
} = await import("../src/graph/traverse.js");

describe.skipIf(skip)("graph traversal (AC-008/010)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { readFileSync, readdirSync } = await import("node:fs");
    const sqlDir = join(here, "..", "sql");
    await pool.query("CREATE SCHEMA IF NOT EXISTS codebase;");
    for (const f of readdirSync(sqlDir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const sql = readFileSync(join(sqlDir, f), "utf8");
      // Skip HOLD migrations (e.g. 005_drop_bakeoff_scratch.sql) like the real runner.
      if (/^\s*--\s*HOLD\b/im.test(sql.split("\n")[0] ?? "")) continue;
      await pool.query(sql);
    }
    await pool.query("DELETE FROM codebase.index_runs WHERE repository_id=$1", [
      REPO,
    ]);
    await pool.query("DELETE FROM codebase.files WHERE repository_id=$1", [
      REPO,
    ]);
    await indexRepo(sampleRepoDir, REPO, PROJ);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM codebase.index_runs WHERE repository_id=$1", [
      REPO,
    ]);
    await pool.query("DELETE FROM codebase.files WHERE repository_id=$1", [
      REPO,
    ]);
    await pool.end();
  });

  it("clampDepth / clampLimit enforce defaults and the hard cap", () => {
    expect(clampDepth(undefined)).toBe(DEFAULT_DEPTH);
    expect(clampDepth(0)).toBe(1);
    expect(clampDepth(4)).toBe(4);
    expect(clampDepth(99)).toBe(MAX_DEPTH); // hard cap 10
    expect(clampDepth(Number.NaN)).toBe(DEFAULT_DEPTH);
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(7)).toBe(7);
  });

  it("resolves a name seed to its def (depth 0)", async () => {
    const rows = await resolveSeed({
      projectId: PROJ,
      repo: REPO,
      name: "route",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "route",
      file: "route.ts",
      line: 5,
      depth: 0,
      edge_type: "def",
    });
  });

  it("expands the route chain to the fixture rows at depth 1/2/4 (AC-008)", async () => {
    const names = async (depth: number): Promise<string[]> => {
      const rows = await graphExpand({
        seed: { projectId: PROJ, repo: REPO, name: "route" },
        direction: "callees",
        depth,
      });
      return rows.map((r) => `${r.name}@${r.depth}`).sort();
    };

    expect(await names(1)).toEqual(["handleGetUser@1", "route@0"]);
    expect(await names(2)).toEqual(["getUser@2", "handleGetUser@1", "route@0"]);
    // depth 4 bottoms out at findUser@3 (repo.ts is the leaf) — same as depth 3.
    expect(await names(4)).toEqual([
      "findUser@3",
      "getUser@2",
      "handleGetUser@1",
      "route@0",
    ]);
  });

  it("the depth-4 chain carries call edge_type + correct files/lines", async () => {
    const rows = await graphExpand({
      seed: { projectId: PROJ, repo: REPO, name: "route" },
      direction: "callees",
      depth: 4,
    });
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("route")).toMatchObject({
      depth: 0,
      edge_type: "def",
      file: "route.ts",
      line: 5,
    });
    expect(byName.get("handleGetUser")).toMatchObject({
      depth: 1,
      file: "handler.ts",
      line: 5,
    });
    expect(byName.get("findUser")).toMatchObject({
      depth: 3,
      file: "repo.ts",
      line: 9,
    });
    // every non-def hop is a call edge.
    for (const r of rows) {
      if (r.depth > 0) expect(r.edge_type).toContain("call");
    }
  });

  it("clamps depth past the hard cap instead of unbounded recursion", async () => {
    // depth 99 clamps to 10; the linear chain still bottoms out at findUser@3.
    const rows = await graphExpand({
      seed: { projectId: PROJ, repo: REPO, name: "route" },
      direction: "callees",
      depth: 99,
    });
    const maxDepth = Math.max(...rows.map((r) => r.depth));
    expect(maxDepth).toBe(3);
    expect(rows.map((r) => r.name).sort()).toEqual([
      "findUser",
      "getUser",
      "handleGetUser",
      "route",
    ]);
  });

  it("the A↔B cycle terminates (path-array cycle guard, AC-008)", async () => {
    const rows = await graphExpand({
      seed: { projectId: PROJ, repo: REPO, name: "alpha" },
      direction: "callees",
      depth: 10,
    });
    // Finite: exactly alpha@0 + beta@1 — beta's only callee is alpha, already on the path.
    expect(rows.map((r) => `${r.name}@${r.depth}`).sort()).toEqual([
      "alpha@0",
      "beta@1",
    ]);
  });

  it("honors the limit on the final result set", async () => {
    const rows = await graphExpand({
      seed: { projectId: PROJ, repo: REPO, name: "route" },
      direction: "callees",
      depth: 10,
      limit: 2,
    });
    expect(rows).toHaveLength(2);
  });

  it("flags the ambiguous `format` callee as name-matched (AC-010)", async () => {
    const rows = await graphExpand({
      seed: { projectId: PROJ, repo: REPO, name: "useFormat" },
      direction: "callees",
      depth: 2,
    });
    const formats = rows.filter((r) => r.name === "format");
    // useFormat → format resolves to BOTH format symbols (ambiguous.ts + format-alt.ts).
    expect(formats.length).toBe(2);
    expect(formats.every((r) => r.ambiguous)).toBe(true);
    expect(new Set(formats.map((r) => r.file))).toEqual(
      new Set(["ambiguous.ts", "format-alt.ts"]),
    );
  });

  it("callers direction walks edges backwards", async () => {
    // who calls getUser? → handleGetUser.
    const rows = await graphExpand({
      seed: { projectId: PROJ, repo: REPO, name: "getUser" },
      direction: "callers",
      depth: 1,
    });
    expect(rows.map((r) => `${r.name}@${r.depth}`).sort()).toEqual([
      "getUser@0",
      "handleGetUser@1",
    ]);
  });

  it("code_trace_path returns the route→handler→service→repo chain", async () => {
    const { rows, reachedTo } = await tracePath({
      seed: { projectId: PROJ, repo: REPO, name: "route" },
      toName: "findUser",
      depth: 4,
    });
    expect(reachedTo).toBe(true);
    expect(rows.map((r) => r.name)).toEqual([
      "route",
      "handleGetUser",
      "getUser",
      "findUser",
    ]);
  });

  it("code_symbol_lookup returns all matches for a duplicated name", async () => {
    const rows = await lookupSymbol({
      projectId: PROJ,
      repo: REPO,
      name: "format",
    });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.file))).toEqual(
      new Set(["ambiguous.ts", "format-alt.ts"]),
    );
  });

  it("an unknown seed name resolves to no symbol (file-read fallback is the tool's job)", async () => {
    const rows = await graphExpand({
      seed: { projectId: PROJ, repo: REPO, name: "doesNotExist" },
      direction: "both",
    });
    expect(rows).toEqual([]);
  });
});
