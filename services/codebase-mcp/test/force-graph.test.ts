// Wave 3 — forced graph-backfill test (AC-007). Simulates an already-indexed corpus that
// predates the graph feature (files + chunks present, symbols empty), then runs forced mode
// and asserts symbols/edges appear for files whose content_sha256 is UNCHANGED — i.e. the
// force flag bypasses the sha skip so the existing corpus gets a graph on first rollout.
// Also asserts the graph-only force does NOT re-embed unchanged files (no Voyage burn).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const sampleRepoDir = join(here, "fixtures", "sample-repo");
const REPO = "force-graph-test";

const embedCode = vi.fn(async (texts: string[], _inputType: string) =>
  texts.map(() => Array.from({ length: 1024 }, () => 0.001)),
);
vi.mock("../src/voyage.js", () => ({
  embedCode: (...args: [string[], string]) => embedCode(...args),
  toVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
}));

const { indexRepo } = await import("../src/indexer.js");

describe.skipIf(skip)("forced graph backfill (AC-007)", () => {
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

  it("force backfills the graph on an unchanged-sha corpus without re-embedding", async () => {
    // 1. Initial index — files + chunks + symbols written.
    await indexRepo(sampleRepoDir, REPO, "test-proj");
    const filesIndexed = await count(
      "SELECT count(*) AS n FROM codebase.files WHERE repository_id=$1",
      [REPO],
    );
    expect(filesIndexed).toBeGreaterThan(0);

    // 2. Simulate a pre-graph corpus: drop the graph rows but KEEP files + chunks
    //    (so content_sha256 is unchanged on the next run).
    await pool.query(
      "DELETE FROM codebase.symbol_edges WHERE repository_id=$1",
      [REPO],
    );
    await pool.query("DELETE FROM codebase.symbols WHERE repository_id=$1", [
      REPO,
    ]);
    expect(
      await count(
        "SELECT count(*) AS n FROM codebase.symbols WHERE repository_id=$1",
        [REPO],
      ),
    ).toBe(0);

    // 3. A NON-forced re-index must skip everything (sha unchanged) → graph stays empty.
    embedCode.mockClear();
    await indexRepo(sampleRepoDir, REPO, "test-proj", false);
    expect(
      await count(
        "SELECT count(*) AS n FROM codebase.symbols WHERE repository_id=$1",
        [REPO],
      ),
    ).toBe(0);

    // 4. A FORCED re-index backfills the graph despite unchanged sha (AC-007)...
    embedCode.mockClear();
    await indexRepo(sampleRepoDir, REPO, "test-proj", true);
    expect(
      await count(
        "SELECT count(*) AS n FROM codebase.symbols WHERE repository_id=$1",
        [REPO],
      ),
    ).toBe(10);
    expect(
      await count(
        "SELECT count(*) AS n FROM codebase.symbol_edges WHERE repository_id=$1",
        [REPO],
      ),
    ).toBeGreaterThan(0);

    // 5. ...and graph-only force did NOT re-embed (no Voyage quota burned on unchanged files).
    expect(embedCode).not.toHaveBeenCalled();
  });
});
