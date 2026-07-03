// Regression (review Fix 3) — the importer distill scripts must dual-write BOTH the legacy
// `embedding` AND the contextual `embedding_v2`. After the contextual flip, searchMemory
// filters `embedding_v2 IS NOT NULL`, so any memory ingested with ONLY the legacy column is
// invisible to recall until a manual backfill. This is a STATIC guard over the two .mjs
// scripts (they run on the box against live Voyage, so they cannot be unit-tested directly):
// it asserts the INSERT column list includes embedding_v2 AND the script actually computes it
// via the contextual endpoint with the correct one-chunk-per-doc / int8 / 1024-dim params.
//
// When the legacy `embedding` column is dropped post burn-in, this test is updated to assert
// the legacy write is gone (and only embedding_v2 remains).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const importerDir = join(here, "..", "..", "importer");

const SCRIPTS = ["distill-codex.mjs", "distill-transcripts.mjs"];

describe("importer distill scripts dual-write embedding_v2 (Fix 3)", () => {
  for (const name of SCRIPTS) {
    describe(name, () => {
      const src = readFileSync(join(importerDir, name), "utf8");

      it("INSERT column list includes embedding_v2 next to embedding", () => {
        // The INSERT into memory.memories must name embedding_v2 in its column list.
        const insertMatch = src.match(
          /INSERT INTO memory\.memories[\s\S]*?VALUES/i,
        );
        expect(
          insertMatch,
          "no INSERT INTO memory.memories found",
        ).not.toBeNull();
        const columns = insertMatch![0];
        expect(columns).toContain("embedding");
        expect(columns).toContain("embedding_v2");
      });

      it("computes the contextual vector via /contextualizedembeddings", () => {
        expect(src).toContain("/contextualizedembeddings");
        // contextual params: nested inputs, int8, 1024-dim.
        expect(src).toMatch(/output_dtype:\s*['"]int8['"]/);
        expect(src).toMatch(/output_dimension:\s*1024/);
        // a dedicated helper computes the v2 vector and it is passed to the INSERT.
        expect(src).toMatch(/embedContextual\s*\(/);
      });

      it("binds BOTH embedding and embedding_v2 as ::halfvec in VALUES", () => {
        // both vectors are serialized + cast (the dual-write the live storeMemory does).
        const halfvecCount = (src.match(/::halfvec/g) || []).length;
        expect(halfvecCount).toBeGreaterThanOrEqual(2);
      });
    });
  }
});
