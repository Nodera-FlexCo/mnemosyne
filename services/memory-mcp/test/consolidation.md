# Consolidation runbook + decision record (wave-5, WS3 — AC-304)

The first REAL A/B of the retrieval harness: measure whether memory consolidation
(cosine > 0.90 candidates → LLM assertion-equivalence → supersession) improves
retrieval precision on OUR corpus. The industry-wide "dedup → precision" claim is
UNVERIFIED (research §consolidation) — this run verifies it here before the change
is accepted.

**This is a FLIP GATE.** Steps 1 and 4 spend the FROZEN TEST SPLIT — the only
sanctioned test-split spend outside embedder/rerank flip gates (test/eval.md,
split policy). Record the outcome in the decision table below and in the gold
file's changelog if the split is ever touched.

**Everything here is operator-run.** Steps marked PAID spend quota. Modeled on
`test/retune.md`.

## Mechanics (what the implementer shipped)

| Piece | Command | Cost |
| --- | --- | --- |
| Consolidation batch job | `npm run consolidate -- --yes` (dry-run) / `-- --yes --apply` | PAID — Anthropic judge (`ANTHROPIC_API_KEY`, `CONSOLIDATE_MODEL`, Haiku-class default; ≈500 tok/pair) |
| Test-split eval recorder | `npm run eval:record -- --yes --label <name>` | PAID (small) — Voyage embeds every test-split query |
| Artifact comparator | `npm run eval:compare -- <A.json> <B.json>` | FREE |

The dry-run report `test/runs/consolidate-<date>.json` is the review surface, the
UNDO LOG (its `pairs` list is the exact flip-back target set), and the resumability
cursor store. `--apply` on the same day re-uses the reviewed dry-run report without
re-judging and writes `consolidate-<date>-applied.json`.

Semantics guaranteed by `src/db/consolidate.ts` (proven in `test/consolidate.test.ts`):
losers only ever get `status='superseded'` + `superseded_by=<winner>` — content is
never edited or deleted; pinned rows never lose; decision rows never enter; judge
failures fail OPEN to UNJUDGED (-1: zero changes, re-judged next run); the eval
runner resolves `superseded_by` forward chains (AC-106), so gold is never orphaned.

## Procedure

### 0. Pre-flight (one-time, BEFORE recording the pre-consolidation baseline)

a) **Embedding completeness** — the sweep only sees rows with `embedding_v2`:

```sql
SELECT count(*) FROM memory.memories
WHERE archived_at IS NULL AND COALESCE(status,'active')='active'
  AND embedding_v2 IS NULL;
```

Expected 0. If not, run `npm run backfill:context` (PAID) first.

b) **Orphaned-supersession guard** — expected count **4** (the known orphaned
superseded rows):

```sql
SELECT count(*) FROM memory.memories
WHERE status='superseded' AND superseded_by IS NULL;
```

- Count is exactly 4 → repair and record the affected ids in this file:

```sql
UPDATE memory.memories SET status='archived'
WHERE status='superseded' AND superseded_by IS NULL;
```

- Count DIFFERS from 4 → **STOP and inspect before any consolidation step.** The
  live count was not independently verifiable at plan time; this guard is the
  control. (Repaired ids: _record here when executed_.)

### 1. Pre-consolidation baseline (PAID small)

```bash
DATABASE_URL=<live> npm run eval:record -- --yes --label pre-consolidation
```

Commit `test/runs/<date>-pre-consolidation.json`.

### 2. Dry-run + human review (PAID — judge calls)

```bash
DATABASE_URL=<live> ANTHROPIC_API_KEY=<key> npm run consolidate -- --yes
```

Review `test/runs/consolidate-<date>.json` pair by pair: verdict-1 pairs are the
would-supersede set. Check the `reason` fields; anything that reads like a
restatement-with-added-detail being merged is a judge false-positive — STOP and
tighten before applying. UNJUDGED (-1) pairs are fine (they re-enter next run).

### 3. Apply (PAID only if the dry-run report is absent/stale)

```bash
DATABASE_URL=<live> ANTHROPIC_API_KEY=<key> npm run consolidate -- --yes --apply
```

Same-day dry-run report present → applied WITHOUT re-judging (zero new judge
spend); writes `consolidate-<date>-applied.json`.

### 4. Post-consolidation run + paired comparison (PAID small + FREE)

```bash
DATABASE_URL=<live> npm run eval:record -- --yes --label post-consolidation
npm run eval:compare -- test/runs/<date>-pre-consolidation.json test/runs/<date>-post-consolidation.json
```

Commit the post artifact. `eval:compare` joins per-query nDCG@10 by row id and
prints the mean delta + seed-42 paired-bootstrap 95% CI + sign counts.

### 5. Decision + (if needed) undo

Record the verdict here:

| Date | Rows (test split) | nDCG@10 pre → post | Recall@25 pre → post | Δ nDCG 95% CI | Verdict |
| --- | --- | --- | --- | --- | --- |
| _pending_ | | | | | |

- **CI excludes zero on the win side, or includes zero with no pool-recall drop** →
  ACCEPT; keep both artifacts committed; done.
- **CI excludes zero on the regression side (`ciHigh < 0`)** → REVERT: flip every
  applied loser back using the report as the undo log. For EACH pair with
  `verdict: 1` in `consolidate-<date>-applied.json` (loser = the side `keep` does
  NOT name; slot `a` is the older row):

```sql
-- one UPDATE per applied pair; $loser from the report's pair list
UPDATE memory.memories SET status='active', superseded_by=NULL
WHERE id = $loser AND status='superseded';
```

  Then re-run step 4 to confirm the metrics returned to baseline, and record the
  reverted pair ids here.

Supersession is fully reversible by design — one status flip, content untouched.
