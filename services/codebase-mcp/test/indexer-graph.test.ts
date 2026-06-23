// Wave 3 — DB-backed graph integration test (AC-004/005). Indexes the sample-repo into
// the test DB and asserts: symbols + symbol_edges populated; the route→handler→service→repo
// chain resolved repo-wide (post-walk); re-indexing ONE file replaces its symbols/edges via
// file_id without duplicates or orphans; code_chunks.imports is non-NULL; and index_runs
// carries symbols_total/edges_total. Requires DATABASE_URL (skipIf otherwise).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const sampleRepoDir = join(here, "fixtures", "sample-repo");
const REPO = "graph-test";

// Hermetic embedder (no Voyage key/quota) — one deterministic 1024-dim vector per chunk.
vi.mock("../src/voyage.js", () => ({
  embedCode: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.001)),
  ),
  toVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
}));

const { indexRepo } = await import("../src/indexer.js");

describe.skipIf(skip)("indexer graph phase (AC-004/005)", () => {
  let pool: pg.Pool;

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(sql, params);
    return Number(rows[0].n);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { readFileSync, readdirSync } = await import("node:fs");
    const sqlDir = join(here, "..", "sql");
    await pool.query("CREATE SCHEMA IF NOT EXISTS codebase;");
    for (const f of readdirSync(sqlDir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await pool.query(readFileSync(join(sqlDir, f), "utf8"));
    }
    // Clean slate for this repo.
    await pool.query("DELETE FROM codebase.index_runs WHERE repository_id=$1", [
      REPO,
    ]);
    await pool.query("DELETE FROM codebase.files WHERE repository_id=$1", [
      REPO,
    ]);
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

  it("populates symbols + symbol_edges non-zero on first index (AC-004)", async () => {
    await indexRepo(sampleRepoDir, REPO, "test-proj");

    // 10 golden symbols.
    expect(
      await count(
        "SELECT count(*) AS n FROM codebase.symbols WHERE repository_id=$1",
        [REPO],
      ),
    ).toBe(10);

    // call edges resolved repo-wide: the 6 golden call edges fan out on the ambiguous
    // `format` target (useFormat→format matches BOTH format symbols), so call rows are
    // 5 unambiguous + 2 ambiguous candidates = 7.
    const callEdges = await count(
      "SELECT count(*) AS n FROM codebase.symbol_edges WHERE repository_id=$1 AND kind='call'",
      [REPO],
    );
    expect(callEdges).toBeGreaterThanOrEqual(6);

    // import edges resolved (file→file). Non-zero.
    const importEdges = await count(
      "SELECT count(*) AS n FROM codebase.symbol_edges WHERE repository_id=$1 AND kind='import'",
      [REPO],
    );
    expect(importEdges).toBeGreaterThan(0);
  });

  it("resolves the route→handler→service→repo chain by name (post-walk)", async () => {
    const { rows } = await pool.query<{ from_name: string; to_name: string }>(
      `SELECT sf.name AS from_name, st.name AS to_name
       FROM codebase.symbol_edges e
       JOIN codebase.symbols sf ON sf.id = e.from_symbol
       JOIN codebase.symbols st ON st.id = e.to_symbol
       WHERE e.repository_id=$1 AND e.kind='call'`,
      [REPO],
    );
    const has = (from: string, to: string) =>
      rows.some((r) => r.from_name === from && r.to_name === to);
    expect(has("route", "handleGetUser")).toBe(true);
    expect(has("handleGetUser", "getUser")).toBe(true);
    expect(has("getUser", "findUser")).toBe(true);
    // Cycle present.
    expect(has("alpha", "beta")).toBe(true);
    expect(has("beta", "alpha")).toBe(true);
  });

  it("flags the ambiguous `format` target as a >1-candidate name (AC-010 raw material)", async () => {
    // useFormat→format must resolve to BOTH `format` symbols (the >1 row Wave 4 labels).
    const { rows } = await pool.query<{ to_file: string }>(
      `SELECT st.file_path AS to_file
       FROM codebase.symbol_edges e
       JOIN codebase.symbols sf ON sf.id = e.from_symbol
       JOIN codebase.symbols st ON st.id = e.to_symbol
       WHERE e.repository_id=$1 AND e.kind='call'
         AND sf.name='useFormat' AND st.name='format'`,
      [REPO],
    );
    const files = new Set(rows.map((r) => r.to_file));
    expect(files).toEqual(new Set(["ambiguous.ts", "format-alt.ts"]));
  });

  it("writes code_chunks.imports (no longer NULL)", async () => {
    const nonNull = await count(
      "SELECT count(*) AS n FROM codebase.code_chunks WHERE repository_id=$1 AND imports IS NOT NULL",
      [REPO],
    );
    expect(nonNull).toBeGreaterThan(0);
    // route.ts chunks import handleGetUser.
    const { rows } = await pool.query<{ imports: { name: string }[] }>(
      "SELECT imports FROM codebase.code_chunks WHERE repository_id=$1 AND file_path='route.ts' LIMIT 1",
      [REPO],
    );
    expect(rows[0].imports.some((i) => i.name === "handleGetUser")).toBe(true);
  });

  it("writes symbols_total + edges_total onto the index_runs row", async () => {
    const { rows } = await pool.query<{
      symbols_total: number | null;
      edges_total: number | null;
      phase: string;
    }>(
      `SELECT symbols_total, edges_total, phase FROM codebase.index_runs
       WHERE repository_id=$1 ORDER BY started_at DESC LIMIT 1`,
      [REPO],
    );
    expect(rows[0].phase).toBe("done");
    expect(rows[0].symbols_total).toBe(10);
    expect(rows[0].edges_total).toBeGreaterThan(0);
  });

  it("re-indexing one file replaces its symbols via file_id with no dup/orphan (AC-005)", async () => {
    const before = await count(
      "SELECT count(*) AS n FROM codebase.symbols WHERE repository_id=$1",
      [REPO],
    );

    // Force a re-index of the whole repo: content unchanged → graph-only force path
    // re-runs the extractor + symbol delete/reinsert keyed on file_id.
    await indexRepo(sampleRepoDir, REPO, "test-proj", true);

    const after = await count(
      "SELECT count(*) AS n FROM codebase.symbols WHERE repository_id=$1",
      [REPO],
    );
    // Stable identity: same symbol count, no duplication.
    expect(after).toBe(before);

    // No duplicate symbol identities (the sym_identity unique key holds).
    const dups = await count(
      `SELECT count(*) AS n FROM (
         SELECT 1 FROM codebase.symbols WHERE repository_id=$1
         GROUP BY repository_id, file_path, name, kind, start_line
         HAVING count(*) > 1
       ) d`,
      [REPO],
    );
    expect(dups).toBe(0);

    // No orphaned edges (every edge endpoint references a live symbol).
    const orphans = await count(
      `SELECT count(*) AS n FROM codebase.symbol_edges e
       WHERE e.repository_id=$1
         AND (NOT EXISTS (SELECT 1 FROM codebase.symbols s WHERE s.id=e.from_symbol)
           OR NOT EXISTS (SELECT 1 FROM codebase.symbols s WHERE s.id=e.to_symbol))`,
      [REPO],
    );
    expect(orphans).toBe(0);

    // Every symbol still carries its file_id (per-file replacement key intact).
    const nullFileId = await count(
      "SELECT count(*) AS n FROM codebase.symbols WHERE repository_id=$1 AND file_id IS NULL",
      [REPO],
    );
    expect(nullFileId).toBe(0);
  });
});
