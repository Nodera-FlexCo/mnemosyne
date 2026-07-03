# Mnemosyne

Dual-engine memory + codebase search for Claude Code, self-hosted on a Hetzner
EX44. See `mnemosyne-ex44-revision.md` (one level up) for the full architecture.

## Layout

```
compose.yaml            # service stack (postgres, redis, memory/codebase/secrets MCP, langfuse, cloudflared)
postgres/init/          # first-boot SQL (extensions + schemas)
systemd/                # mnemosyne.service — supervises `docker compose` on boot
services/memory-mcp/    # durable cross-session memory engine (Stage 1)
services/codebase-mcp/  # semantic + lexical code search + AST code graph (Stage 2)
services/secrets-mcp/   # encrypted secrets store
services/importer/      # bulk transcript/decision distill → memory ingest
docs/                   # operator runbooks (see Runbooks below)
.env.example            # config template; real .env is generated on the box
```

## Host

- Box: `mnemo` SSH alias → root@157.180.50.51 (Ubuntu 26.04, i5-13500, 125GB, RAID1 NVMe)
- Deploy target: `/opt/mnemosyne` (owned by `development`)

## Common commands (run on the box, in /opt/mnemosyne)

```bash
make secrets     # generate .env with strong random secrets (once)
docker compose up -d postgres redis
docker compose up -d --build memory-mcp codebase-mcp
docker compose ps
docker compose logs -f postgres
```

### Per-service migrations (manual — never auto-run on deploy)

Neither MCP service applies its SQL on container boot. Migrations are an explicit,
loopback-only operator step run AFTER the relevant image is built. The runner
(`src/db/migrate.ts` in each service) applies `sql/*.sql` in lexical order and
**skips any file whose first line begins with `-- HOLD`** (those are deliberate,
gated drops — see the runbook).

```bash
# memory-mcp — applies 001..003 + 005..006; SKIPS 004 (HOLD legacy-embedding drop)
DATABASE_URL=<loopback> npm --prefix services/memory-mcp run migrate

# codebase-mcp — applies 001..004; SKIPS 005 (HOLD bake-off-scratch drop)
DATABASE_URL=<loopback> npm --prefix services/codebase-mcp run migrate
```

### Deliberate, paid ops actions (operator-run, NOT auto-on-deploy)

These spend Voyage API quota and are gated, one-time, per-rollout steps. They are
**never** invoked by a container start hook. Full step-by-step in
[`docs/Runbooks-CodeGraph-ContextEmbeddings.md`](docs/Runbooks-CodeGraph-ContextEmbeddings.md).

```bash
# memory-mcp — contextual blue/green re-embed (Wave P)
npm --prefix services/memory-mcp run backfill:context   # populate embedding_v2
npm --prefix services/memory-mcp run index:v2           # build mem_hnsw_v2 CONCURRENTLY
npm --prefix services/memory-mcp run index:decision     # build the decision partial HNSW CONCURRENTLY

# codebase-mcp — code-embedder bake-off (Wave 5: voyage-code-3 vs voyage-context-3)
npm --prefix services/codebase-mcp run bakeoff -- <projectId> [repositoryId]
```

### Eval-harness operator scripts (retrieval-improvement program, wave 2)

Gold-set growth is "synthetic-now, logs-forever": every script only PROPOSES candidates —
a human approves every gold id/path before it enters an eval split. Handbook:
[`services/memory-mcp/test/eval.md`](services/memory-mcp/test/eval.md).

```bash
# FREE — convert title-keyed seed gold to stable-id v2 (writes recall-eval.v2.json for review)
DATABASE_URL=<loopback> npm --prefix services/memory-mcp run gold:migrate

# PAID (Anthropic quota, Haiku-class; needs ANTHROPIC_API_KEY, optional DISTILL_MODEL) —
# LLM-distill eval-query candidates from the corpus; refuses without --yes
DATABASE_URL=<loopback> npm --prefix services/memory-mcp   run distill-eval -- --yes
DATABASE_URL=<loopback> npm --prefix services/codebase-mcp run distill-eval -- --yes

# FREE — monthly gold rotation from real memory.search_log usage (frequent/zero-hit/
# low-overlap queries not already in gold); flags: --days 30 --min-count 2 --limit 40
DATABASE_URL=<loopback> npm --prefix services/memory-mcp run harvest-eval

# PAID (Voyage quota — embeds every dev query) — the flip-gate run: record a run
# artifact, freeze it as the committed baseline, then the CI gate does the statistics
DATABASE_URL=<live> VOYAGE_API_KEY=<live> EVAL_RECORD=1 \
  npm --prefix services/memory-mcp run test -- recall-gate
```

## MCP tools

### memory-mcp (durable memory)

`memory_search` · `memory_store` · `memory_get` · `memory_get_recent` ·
`memory_update` · `memory_list` · `memory_delete` · `memory_get_entity` ·
`memory_decision_chain`

- **`memory_store`** now accepts a typed **decision-log** shape (only meaningful when
  `sourceKind='decision'`): `decisionProject`, `decisionStatus`
  (`active`|`superseded`|`deferred`), `decidedAt`, `supersedesId` (the prior decision
  THIS one replaces), `decidedIn`, `relatedIds[]`. Non-decision rows leave these NULL.
- **`memory_decision_chain`** (new) — walks the supersession chain backward from a
  decision via `supersedes_id` (this decision → the one it superseded → …) using a
  recursive CTE, returning the ordered lineage with `decision_status` + `decided_at`.

### codebase-mcp (code search + AST graph)

`code_search` · `code_get_file` · `code_index_status` · `code_reindex` ·
`code_graph_expand` · `code_symbol_lookup` · `code_trace_path`

- **`code_graph_expand`** (new) — given a symbol name, a `file`(+`line`), or a
  `code_search` `chunkId`, returns its definition plus callers/callees from the AST call
  graph as structured rows `{name, file:line, depth, edge_type}`. `direction`
  (`callees`|`callers`|`both`, default `both`), `depth` (default 4, hard cap 10), `limit`
  (default 50). Falls back to a file read when the graph has no edges for the seed
  (un-graphed repo / non-TS file / unknown name). Name-matched (ambiguous) hops are
  labeled "(name-matched, may be ambiguous)".
- **`code_symbol_lookup`** (new) — resolve a symbol name to its definition(s)
  `{name, kind, file:line}`; multiple matches are returned with an ambiguity note.
- **`code_trace_path`** (new) — follow call edges downstream from a seed and return the
  ordered chain `{name, file:line, edge_type, depth}` (route → handler → service → repo).
  Pass `to` to stop at a target name. Edges are by-name, so this returns A resolved path,
  not a proven-unique one.
- **`code_index_status`** (enriched) — in addition to per-repo file/chunk counts and last
  index time, it now surfaces the latest `codebase.index_runs` row: `phase` (terminal
  `done`/`error`), files done/total, chunks total, current file, error text, and
  start/finish times — so a failed detached index is no longer invisible.
- **`code_reindex`** (enriched) — `force:true` bypasses the `content_sha256` skip so an
  ALREADY-indexed corpus gets its code graph built on first rollout. Forced runs are
  graph-only for unchanged files (no re-embed, so no Voyage quota burn).

## Code graph + contextual embeddings

Two capabilities landed on the Stage 1/2 engines:

**Deterministic AST code graph (codebase-mcp).** Indexing now extracts symbols and call /
import edges with tree-sitter (TypeScript) into `codebase.symbols` + `codebase.symbol_edges`
(a hardened schema with `project_id`, a `file_id` FK, and a uniqueness key — migration
`003_graph_constraints.sql`). Edges are resolved by name in a post-walk phase under a
per-repo advisory lock; name-ambiguous edges are labeled, not hidden (scip-typescript was
deferred for the Node 18/20 vs node:22 runtime mismatch). Re-indexing a file replaces its
symbols/edges via a `file_id`-keyed delete+reinsert. The `index_runs` lifecycle table
(`002_index_jobs.sql`) makes the detached indexer observable through `code_index_status`.
The native tree-sitter binding is a runtime dependency that survives the build→runtime
Docker copy (AC-012). The three graph tools above query a recursive-CTE traversal with a
depth cap, a limit, and a path-array cycle guard, and fall back to a file read when the
graph is empty.

**Contextual embeddings (memory-mcp).** Memory embeddings move from the legacy flat
`embedding` (voyage-4-large) to `embedding_v2` (voyage-context-4 contextual, 1024-dim int8
`halfvec`) via a **blue/green** swap: a parallel column is added (`003_context_embeddings.sql`),
backfilled out of band (`backfill:context`), indexed CONCURRENTLY (`index:v2`), then the
query path flips — **gated on a recall check** against a held-out eval set, never an eyeball.
The RRF `k`, the `0.7·rel + 0.2·recency + 0.1·importance` blend, and the reranker are
re-tuned BEFORE the flip (re-embed couples to fusion/rerank). The legacy column is dropped
only after burn-in (`004_drop_legacy_embedding.sql`, HOLD). A code-embedder **bake-off**
(Wave 5) scores voyage-code-3 vs voyage-context-3 on the code corpus into a scratch column
(`004_bakeoff_scratch.sql`) without touching live search, and picks per Recall@10.

**Decision-log metadata (memory-mcp).** Decisions are structured columns on
`memory.memories` (`005_decision_log.sql`) — a sparse typed shape for `source_kind='decision'`
rows, NOT an LLM-extracted temporal KG. Supersession walks `supersedes_id` (backward) via a
recursive CTE; the live `entities`/`entity_edges` graph is never mutated by a decision write.

### Decision records (per-wave, fill from the live run)

- Code bake-off procedure + recorded result → [`services/codebase-mcp/test/bakeoff.md`](services/codebase-mcp/test/bakeoff.md)
- Memory retune / flip-gate decision record → [`services/memory-mcp/test/retune.md`](services/memory-mcp/test/retune.md)
- Decision-log entity-link policy (ADR) → [`services/memory-mcp/test/decision-log.md`](services/memory-mcp/test/decision-log.md)

## Migration inventory

| Service | File | Wave | Applied by runner? |
| --- | --- | --- | --- |
| codebase-mcp | `001_codebase.sql` | base | yes |
| codebase-mcp | `002_index_jobs.sql` | 1 | yes |
| codebase-mcp | `003_graph_constraints.sql` | 2 | yes |
| codebase-mcp | `004_bakeoff_scratch.sql` | 5 | yes |
| codebase-mcp | `005_drop_bakeoff_scratch.sql` | 5 | **HOLD** — skipped (apply post-decision) |
| memory-mcp | `001_memory.sql` | base | yes |
| memory-mcp | `002_migration.sql` | base | yes |
| memory-mcp | `003_context_embeddings.sql` | P | yes |
| memory-mcp | `004_drop_legacy_embedding.sql` | P | **HOLD** — skipped (apply post burn-in) |
| memory-mcp | `005_decision_log.sql` | 6 | yes |
| memory-mcp | `006_search_log.sql` | retrieval wave 2 | yes |

The two `CREATE INDEX CONCURRENTLY` indexes (`mem_hnsw_v2`, the decision partial HNSW)
cannot run inside the batch runner's transaction, so they are built by standalone op
scripts: `npm run index:v2` and `npm run index:decision`.

## Stages

- [x] Stage 0: host hardening, Docker, data layer
- [ ] Stage 0: cloudflare tunnel (needs domain + token)
- [x] Stage 1: memory engine — durable hybrid (semantic + lexical) recall + entity graph;
      contextual embeddings (voyage-context-4, blue/green) + structured decision log
- [x] Stage 2: codebase engine — semantic + lexical code search + deterministic AST code
      graph (symbols + call/import edges) with the three graph tools + observable indexing
- [ ] Stage 3: optimization — eval harness (Langfuse + Promptfoo); the code-embedder
      bake-off (voyage-code-3 vs voyage-context-3) is the advanced, paid measurement step
