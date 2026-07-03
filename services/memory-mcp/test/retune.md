# Wave P retune procedure — the embedder-flip gate decision record (AC-024)

After the contextual re-embed (`embedding_v2` via voyage-context-3) and **before** the
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
4. **Freeze a held-out eval set.** Expand `fixtures/recall-eval.json` from the seed rows
   to ≥30–50 `query → relevantTitles` rows drawn from the LIVE corpus, using verbatim
   memory titles. Mark each row `"heldOut": true`; keep the originals `"seed": true`.
5. **Baseline (v1) + candidate (v2) recall.** Run the recall harness as the live gate:
   ```
   DATABASE_URL=<live> VOYAGE_API_KEY=<live> VOYAGE_LIVE_TESTS=1 npx vitest run recall-gate
   ```
   - Record the **v1** recall@10/MRR (incumbent `embedding`) → fill `BEFORE` below.
   - Record the **v2** recall@10/MRR (`embedding_v2`, both sides contextual) → `AFTER`.
6. **Retune constants** on the SAME held-out set (sweep `RRF_K` ∈ {30,40,60,80}, the
   blend weights, confirm rerank-2.5-lite still helps), then set the finalized values in
   `src/memory.ts` and record them below.
7. **Flip gate (AC-023):** flip to v2 ONLY if v2 recall@10 ≥ v1 recall@10 (no regression;
   a lift is preferred). If it regresses, do NOT flip — investigate retune/embedder.
8. After a burn-in window, apply `sql/004_drop_legacy_embedding.sql` (lift the HOLD) and
   remove the legacy `embed()` write from `memory.ts`.

## Recorded numbers

| Metric              | BEFORE (v1, `embedding`) | AFTER (v2, `embedding_v2`) |
| ------------------- | ------------------------ | -------------------------- |
| recall@10           | TBD — filled by operator after the live backfill run | TBD |
| MRR@10              | TBD                      | TBD                        |
| held-out set size   | TBD                      | (same set)                 |

## Finalized tuned constants (set in `src/memory.ts`)

| Constant                 | Default (pre-flip) | Tuned (operator) |
| ------------------------ | ------------------ | ---------------- |
| `RRF_K`                  | 60                 | TBD              |
| `BLEND_RELEVANCE`        | 0.7                | TBD              |
| `BLEND_RECENCY`          | 0.2                | TBD              |
| `BLEND_IMPORTANCE`       | 0.1                | TBD              |
| `RECENCY_HALFLIFE_DAYS`  | 30                 | TBD              |
| reranker                 | rerank-2.5-lite    | TBD (confirm still helps) |

## Why a recall gate, not eyeball

`recallAtK`/`mrr` are unit-tested pure functions (`recall.helper.test.ts`); the flip gate
is encoded as `recall-gate.test.ts` (skips until `embedding_v2` is populated). The gate is
"v2 recall@10 ≥ v1 baseline" — a green eyeball on a few queries can hide a corpus-wide
regression, so the decision is the recorded number, not a spot-check.

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
