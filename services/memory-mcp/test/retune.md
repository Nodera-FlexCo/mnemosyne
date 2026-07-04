# Wave P retune procedure — the embedder-flip gate decision record (AC-024)

After the contextual re-embed (`embedding_v2` via voyage-context-4) and **before** the
query flip goes live, the RRF/blend/rerank constants MUST be re-tuned on a held-out eval
set. Re-embed couples to fusion/rerank: flipping the embedding column without re-tuning
silently regresses recall (the locked caveat, memory `0350c509`). This file is the
decision record the operator fills in after the **live** backfill run.

> The code flip is already landed (`src/memory.ts` reads `embedding_v2`, embeds the query
> via `embedContextualSingle`, and reads the tuned constants `RRF_K`, `BLEND_RELEVANCE`,
> `BLEND_RECENCY`, `BLEND_IMPORTANCE`, `RECENCY_HALFLIFE_DAYS`). It goes live at the
> **gated redeploy**, not before — the constants below are at no-regression defaults
> until the operator finalizes them here.

## What the operator runs (live — paid Voyage quota)

These are the steps I (the operator) run; they are NOT run by the implementer/CI.

1. **Apply migrations on the live DB** (loopback):
   ```
   cd services/memory-mcp && DATABASE_URL=<live> npm run migrate
   ```
   Applies `003_context_embeddings.sql` (ADD COLUMN embedding_v2). `004` is HOLD-skipped.
2. **Backfill the contextual column** (deliberate, paid):
   ```
   DATABASE_URL=<live> VOYAGE_API_KEY=<live> npm run backfill:context
   ```
   Verify completeness (AC-021):
   ```
   SELECT count(*) FROM memory.memories
   WHERE archived_at IS NULL AND COALESCE(status,'active')='active' AND embedding_v2 IS NULL;
   -- must be 0
   ```
3. **Build the contextual HNSW index** (CONCURRENTLY, own connection):
   ```
   DATABASE_URL=<live> npm run index:v2
   ```
   **Then, after this (and after ANY future mass re-embed of `embedding_v2`), reindex +
   vacuum** — a mass re-embed leaves the HNSW graph full of dead tuples, which silently
   degrades result counts, and VACUUM alone is slow against a bloated index (reindex
   first, then vacuum). Run via psql on the live DB; CONCURRENTLY needs its own
   connection (not the batch migrate runner), takes ~2× the plain build, and keeps
   writes flowing:
   ```sql
   REINDEX INDEX CONCURRENTLY mem_hnsw_v2;
   VACUUM (VERBOSE) memory.memories;
   ```
   (Skip the REINDEX only when `index:v2` just created `mem_hnsw_v2` from scratch on an
   already-backfilled column — a fresh build has no dead tuples; still VACUUM.)
4. **Freeze the eval set (wave-2 v2 gold).** Migrate the title-keyed seeds to stable-id
   v2 gold (`npm run gold:migrate` proposes `recall-eval.v2.json`; a human approves every
   id), expand to ≥30–50 rows from the LIVE corpus (distill/harvest proposals, human
   approval), and freeze the **test** split — flip decisions are scored on it, never on
   the freely-recomputed dev split (AC-109). Shape + policy: `test/eval.md`.
5. **Baseline + candidate runs through the wave-2 eval spine** (replaces the retired
   scalar-baseline mechanism — see the note below). Record a run artifact and freeze it
   as the committed baseline, then the gate does the statistics:
   ```
   DATABASE_URL=<live> VOYAGE_API_KEY=<live> EVAL_RECORD=1 npx vitest run recall-gate
   cp test/runs/<date>-dev.json test/runs/baseline-dev.json   # commit it
   DATABASE_URL=<live> VOYAGE_API_KEY=<live> npx vitest run recall-gate
   ```
   The gate joins per-query nDCG@10 against `baseline-dev.json` by row id and fails on
   a paired-bootstrap 95% CI excluding zero on the regression side, plus a coarse
   pool-layer Recall@25 floor (−0.05 absolute). Fill `BEFORE`/`AFTER` below from the
   two artifacts' aggregates. Full semantics: `test/eval.md`.
6. **Retune constants** on the SAME held-out set (sweep `RRF_K` ∈ {30,40,60,80}, the
   blend weights, confirm rerank-2.5-lite still helps), then set the finalized values in
   `src/memory.ts` and record them below.
7. **Flip gate (AC-023):** flip to v2 ONLY if the v2 run shows no regression vs the v1
   baseline on the gate metrics (paired-bootstrap CI on per-query nDCG@10 + the pool
   Recall@25 floor; a lift is preferred). If it regresses, do NOT flip — investigate
   retune/embedder. (The original scalar "v2 recall@10 ≥ v1 recall@10" phrasing is
   retired — see the wave-2 note below.)
8. After a burn-in window, apply `sql/004_drop_legacy_embedding.sql` (lift the HOLD) and
   remove the legacy `embed()` write from `memory.ts`.

## Recorded numbers — G0, 2026-07-03 (operator record)

Corpus: 2124 active memories, project `nodex`, fully backfilled with
**voyage-context-4** (AC-021 probe = 0), `mem_hnsw_v2` REINDEXed + VACUUMed.
Gold: frozen v2 `recall-eval.json` (58 rows, 38 dev / 20 test, incl. the amended-G0
temporal expansion m-051..m-058). Artifact: `test/runs/baseline-dev.json`
(= the committed `2026-07-03-dev.json` run over the 38-row dev split):
**pool Recall@25 0.9474 · nDCG@10 0.7404 · MRR@10 0.7673** — these are THE gate
reference numbers. The table below is the earlier 33-row pre-temporal split, kept
because it is the only matched context-3-vs-context-4 comparison on record.

**BEFORE (v1, `embedding`) was never measured**: the scalar `V1_RECALL_AT_10_BASELINE`
mechanism was retired before any v1 number was recorded, and the branch code cannot
exercise the legacy query path (the flip is compiled in). The flip decision therefore
rests on (a) healthy absolute v2 numbers below, (b) the research-grounded expectation
for contextual embeddings, and (c) the intact rollback path (legacy `embedding` column
+ `mem_hnsw` stay until burn-in; `004` stays HOLD).

| Metric (33-row pre-temporal dev split) | context-3 v2 (accidental arm, see note) | context-4 v2 |
| -------------------------------------- | --------------------------------------- | ------------ |
| pool Recall@25                          | 0.9394                                   | 0.9394       |
| nDCG@10                                 | 0.6917                                   | 0.7035       |
| MRR@10                                  | 0.7121                                   | 0.7321       |
| dev-split size                          | 33                                       | 33 (same set) |

> **Accidental context-3 vs context-4 comparison:** a compose env-default drift
> (fixed the same day — the model is now hard-pinned in `compose.yaml`) first ran the
> backfill AND the eval with voyage-context-3, producing a *matched* context-3 pipeline
> measurement before the corrected context-4 re-run of the identical dev split on the
> identical corpus rows. context-4 wins directionally: +0.012 nDCG@10, +0.020 MRR@10,
> equal pool recall. N=33, not statistically gated — recorded as corroboration, not
> proof. Zero-nDCG rows in both arms: m-018, m-023 (known-hard gold).

## Finalized tuned constants (set in `src/memory.ts`)

Kept at the no-regression defaults for the G0 flip: the baseline is healthy and the
step-6 sweep (RRF_K × blend × reranker) is deferred to the wave-5/6 harness machinery
(`eval:compare` + `bakeoff:rerank`), where each arm becomes a recorded, paired-gated
A/B instead of an eyeballed sweep. Constants remain the single source in `src/memory.ts`;
any future retune lands there and re-records here.

| Constant                 | Default (pre-flip) | Tuned (operator) |
| ------------------------ | ------------------ | ---------------- |
| `RRF_K`                  | 60                 | 60 (kept; sweep deferred to wave-5/6 A/B) |
| `BLEND_RELEVANCE`        | 0.7                | 0.7 (kept)       |
| `BLEND_RECENCY`          | 0.2                | 0.2 (kept)       |
| `BLEND_IMPORTANCE`       | 0.1                | 0.1 (kept)       |
| `RECENCY_HALFLIFE_DAYS`  | 30                 | 30 (kept)        |
| reranker                 | rerank-2.5-lite    | rerank-2.5-lite (wave-6 bakeoff decides the 2.5 swap; decision record: [`../../codebase-mcp/test/bakeoff.md`](../../codebase-mcp/test/bakeoff.md#rerank-bakeoff-wave-6-ws5)) |

## Why a recall gate, not eyeball

`recallAtK`/`mrr`/`ndcgAtK`/`pairedBootstrapCI` are unit-tested pure functions
(`recall.helper.test.ts`); the flip gate is encoded as `recall-gate.test.ts` (skips until
`embedding_v2` is populated and a baseline artifact exists). A green eyeball on a few
queries can hide a corpus-wide regression, so the decision is the recorded number, not a
spot-check.

> **Wave-2 note:** the original scalar mechanism (`V1_RECALL_AT_10_BASELINE`, "v2
> recall@10 ≥ a recorded number") is **retired**. The gate now recomputes the dev split
> and compares per-query nDCG@10 against the committed `test/runs/baseline-dev.json`
> with a paired bootstrap (seed 42) — "no significant regression + directional win".
> The frozen **test** split is spent only by flip gates (AC-109). Handbook:
> `test/eval.md`.

## Two-phase search core (Wave 1, retrieval-improvement program)

`searchMemory` is now composition over two exported phases in `src/memory.ts`:

- **`fuseCandidates()`** — the ONE hybrid-recall + RRF SQL path, returning the
  `config.candidatePool` (25) candidate pool with per-arm `bm25_rank`/`vec_rank`.
- **`rerankAndBlend()`** — rerank → 0.7·rel + 0.2·recency + 0.1·importance blend →
  top-limit shaping.

The eval harness scores **Recall@25 at `fuseCandidates`** (did the pool surface the gold
row at all?) and **nDCG@10 at the full pipeline** (did rerank+blend order it well?), both
through the exact code the live handler runs — never a duplicated SQL path (AC-102). A
golden-output pin (`test/search-golden.test.ts`, recorded pre-split) guards the split
itself (AC-101).

All retrieval constants now snapshot via the exported **`retrievalConfig()`**; every eval
run serializes it into its artifact (AC-104), so any recorded number in this file is
reproducible against the exact configuration that produced it. Retuned constants land in
`src/memory.ts` as before — the snapshot follows automatically (single source).
