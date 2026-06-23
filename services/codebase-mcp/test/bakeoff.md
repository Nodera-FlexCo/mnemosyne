# Code embedder bake-off — voyage-code-3 vs voyage-context-3 (AC-030/AC-031)

This is the procedure + the recorded result for the codebase-mcp embedder decision: keep
the incumbent **voyage-code-3** or swap to **voyage-context-3**, on the CODE corpus, at
Matryoshka **1024 + int8**, scored on **Recall@10 + MRR@10** over a labeled eval set, with
the FULL pipeline (RRF + rerank). The numbers below are **TBD** — filled by the operator
from the live, paid run.

## Why this is non-destructive

The bake-off never touches the live `embedding` column that `code_search` reads. The
contextual arm is written into a **scratch column** `codebase.code_chunks.embedding_ctx`
(`halfvec(1024)`, added by `sql/004_bakeoff_scratch.sql`). The incumbent arm is already in
`embedding` from the normal index. `scoreArm` (in `src/db/bakeoff-embed.ts`) parametrizes
the embedding column, so **both arms run the identical RRF + rerank pipeline** while live
search keeps serving from `embedding` the whole time. The scratch column is dropped only
after the decision, via the **held** migration `sql/005_drop_bakeoff_scratch.sql`.

## Pieces

| Piece | File |
| --- | --- |
| Labeled eval set (≥50 rows, seed) | `test/fixtures/code-eval.json` |
| Scoring math (Recall@k / MRR, pure) | `src/recall-math.ts` (unit-tested in `test/code-eval.helper.test.ts`) |
| Test-facing harness + live-search runner | `test/code-eval.helper.ts` |
| Scratch-embed + per-arm scorer | `src/db/bakeoff-embed.ts` (`bakeoffEmbedContextual`, `scoreArm`) |
| Contextual embedder | `src/voyage.ts` → `embedCodeContextual()` (`/v1/contextualizedembeddings`, dim 1024, int8) |
| Scratch column migration (additive) | `sql/004_bakeoff_scratch.sql` |
| Scratch column drop (HELD) | `sql/005_drop_bakeoff_scratch.sql` |
| Regression guard | `test/code-recall.test.ts` (AC-030) |
| Run script | `npm run bakeoff` |

## Operator runbook (the paid measurement)

Prerequisites: Waves 1–4 merged, the codebase corpus indexed (`embedding` populated),
`VOYAGE_API_KEY` set, and **awareness that the contextual re-embed spends Voyage quota**.

1. **Freeze a real eval set.** Expand `test/fixtures/code-eval.json` from the seed toward
   representative coverage of the live corpora (nodex + mnemosyne). For each row, a human
   confirms the `relevantPaths` are the truly-relevant file(s). Set `_seed: false` and
   freeze. Keep labels honest — this set IS the validation instrument for Voyage's paper
   numbers on YOUR TS repo.

2. **Apply the scratch migration** (additive, idempotent; live search unaffected):

   ```bash
   DATABASE_URL=<prod-or-staging> npm --prefix services/codebase-mcp run migrate
   # applies 004_bakeoff_scratch.sql; SKIPS 005 (HOLD)
   ```

3. **Run the bake-off** (scratch-embeds the contextual arm into `embedding_ctx`, then
   scores BOTH arms). Pass the project id (and optionally a single repo to scope cost):

   ```bash
   DATABASE_URL=<...> VOYAGE_API_KEY=<...> \
     npm --prefix services/codebase-mcp run bakeoff -- <projectId> [repositoryId]
   ```

   It prints, for each arm, `Recall@10` + `MRR@10`. The re-embed is **resumable** (it only
   targets chunks whose `embedding_ctx IS NULL`), so a 429/crash mid-run is safe to re-run.

4. **Record the numbers** in the table below.

5. **Optional cross-check** — the regression guard against the LIVE search path (incumbent
   arm) burns quota, so it is opt-in:

   ```bash
   DATABASE_URL=<...> VOYAGE_API_KEY=<...> VOYAGE_LIVE_TESTS=1 \
     npm --prefix services/codebase-mcp run test -- code-recall
   ```

## Result (TBD — fill from the operator run)

| Arm | Model | Recall@10 | MRR@10 |
| --- | --- | --- | --- |
| Incumbent | voyage-code-3 (`embedding`) | _TBD_ | _TBD_ |
| Candidate | voyage-context-3 (`embedding_ctx`) | _TBD_ | _TBD_ |

**Decision:** _TBD_ — pick the arm with the higher **Recall@10** (AC-030). Tie-break on
MRR@10. A negative result (keep voyage-code-3) is legitimate and expected-plausible:
voyage-code-3 is the code specialist (+13.80% on code per Voyage's own numbers), so the
file-grouped contextual arm has to beat a strong incumbent. **Do not force a swap.**

## Decision procedure — picking the winner + re-tuning (AC-031)

1. **Pick per Recall@10.** Higher Recall@10 wins; MRR@10 breaks ties. Record the pick + the
   numbers above.

2. **If voyage-code-3 wins (incumbent kept):** record the negative result. Drop the scratch
   column (apply the HELD `005_drop_bakeoff_scratch.sql`). Nothing else changes — no swap,
   no retune. Done.

3. **If voyage-context-3 wins (swap):** a swap **without** re-tuning RRF + rerank regresses
   recall (the embedder interacts with fusion — same coupling tax as Wave P). Re-tune
   **before** flipping, gated on the eval set:

   1. **Re-tune RRF.** The RRF constant is `60` in both `search.ts:58` and the bake-off
      `searchArm` (`1.0/(60+rank)`). Sweep it (e.g. 10, 20, 40, 60, 80) and re-score the
      candidate arm with `scoreArm` against the frozen eval set; keep the value that
      maximizes Recall@10 (then MRR@10). Adjust the BM25/vector arm balance if the sweep
      indicates the vector arm should weigh more under the new embedder.
   2. **Re-tune rerank.** Confirm `rerankModel` + `candidatePool` (`config.ts`) still help
      under the new embedder; re-score with the tuned pool.
   3. **Gate the flip.** Require the tuned candidate's Recall@10 ≥ the incumbent baseline
      (no regression); ideally MRR@10 ≥ baseline too. If recall regresses, **do not flip** —
      revisit the retune or the embedder, then re-score.

4. **Flip (only after the gate passes):**
   - `search.ts` — point the `vec` CTE at `embedding_ctx`'s replacement (re-embed the live
     `embedding` with the winner via a forced full reindex, OR repoint search at the
     scratch column and rename). Embed the QUERY with the winning embedder
     (`embedCodeContextual` single-chunk doc) — the query and corpus MUST use the same
     embedder family or recall craters.
   - `indexer.ts` — switch `embedCode` → `embedCodeContextual` (file-grouped) in the index
     path; truncate + reindex via a forced full run (the graph rewrite already forces this,
     so the re-embed is "free" in the same run).
   - `config.ts` + `compose.yaml` + `.env.example` — set `VOYAGE_CODE_MODEL` to the winner.
   - Apply the retuned RRF constant in `search.ts`.

5. **Burn-in, then drop the scratch.** After the new live `embedding` serves `code_search`
   with no recall regression, apply the HELD `005_drop_bakeoff_scratch.sql`. Freeze the
   regression floors: set `CODE_RECALL_FLOOR` / `CODE_MRR_FLOOR` in CI to the recorded
   chosen-arm numbers so `code-recall.test.ts` catches a future regression.

## Per-request caps (the contextual endpoint)

`embedCodeContextual` groups a FILE's chunks as one contextual doc. The caller
(`bakeoffEmbedContextual`) keeps each request under the endpoint caps (≤1000 docs / ≤16k
chunks / ≤120k tokens / ≤32k tokens per doc) via `FILES_PER_REQUEST` + `MAX_CHUNKS_PER_REQUEST`,
and relies on the indexer's `MAX_FILE_BYTES` (400k) guard to bound a single file's chunk
count. A file whose chunks exceed 32k tokens/doc must be split across requests.
