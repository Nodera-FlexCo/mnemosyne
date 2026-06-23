// Test-facing recall harness for the codebase-mcp embedder bake-off (AC-030/AC-031).
//
// The pure scoring math lives in ../src/recall-math.ts (so the operator-run bake-off
// module can import it under tsconfig's `rootDir: src`); this file RE-EXPORTS it plus the
// test-only bits: the eval-file loader and the DB-backed `runCodeRecallEval` runner that
// drives the live `searchCode`.
//
// Mirrors memory-mcp's recall.helper.ts. Code relevance is matched on FILE PATH (a query
// is "satisfied" if a relevant file appears in the top-k), since a query may map to any
// chunk of the right file.

import {
  firstRelevantRank,
  meanRecallAtK,
  meanReciprocalRank,
  recallAtK,
  type CodeEvalFile,
  type CodeRecallEvalResult,
  type RankedPaths,
  type RelevantPaths,
} from "../src/recall-math.js";

// Re-export the pure math + types + loader so test imports (and the bakeoff harness docs)
// can pull everything from one place.
export {
  recallAtK,
  mrr,
  meanRecallAtK,
  meanReciprocalRank,
  normalizePath,
  firstRelevantRank,
  loadCodeEval,
  type RankedPaths,
  type RelevantPaths,
  type CodeEvalRow,
  type CodeEvalFile,
  type CodeRecallEvalResult,
} from "../src/recall-math.js";

/**
 * DB-backed runner: embeds + searches each seed query via the live `searchCode`, then
 * scores the ranked file paths against `relevantPaths`. Requires DATABASE_URL +
 * VOYAGE_API_KEY. `searchCode` is imported lazily so the pure-function tests do not pull
 * in the pg pool / Voyage client when no DB is configured.
 *
 * Scores the LIVE search path (whichever column searchCode reads). The bake-off's per-arm
 * scoring against the SCRATCH column lives in `src/db/bakeoff-embed.ts` (`scoreArm`),
 * which parametrizes the embedding column so both arms run the SAME pipeline.
 */
export async function runCodeRecallEval(
  evalFile: CodeEvalFile,
  opts: { projectId: string; repo?: string; limit?: number },
): Promise<CodeRecallEvalResult> {
  const { searchCode } = await import("../src/search.js");
  const k = evalFile.k;
  const limit = opts.limit ?? Math.max(k, 10);

  const perQuery: {
    hits: RankedPaths;
    relevant: RelevantPaths;
    query: string;
  }[] = [];
  for (const row of evalFile.rows) {
    const hits = await searchCode({
      projectId: opts.projectId,
      query: row.query,
      repo: opts.repo,
      k: limit,
    });
    perQuery.push({
      query: row.query,
      hits: hits.map((h) => h.filePath),
      relevant: row.relevantPaths,
    });
  }

  return {
    recallAtK: meanRecallAtK(perQuery, k),
    mrr: meanReciprocalRank(perQuery),
    perQuery: perQuery.map((q) => ({
      query: q.query,
      rank: firstRelevantRank(q.hits, q.relevant),
      recall: recallAtK(q.hits, q.relevant, k),
    })),
  };
}
