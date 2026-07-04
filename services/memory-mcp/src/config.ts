export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  port: parseInt(process.env.PORT ?? "8080", 10),
  // If unset, the server runs open (fine for localhost-only). Set in prod.
  bearerToken: process.env.MNEMO_TOKEN ?? "",
  defaultProjectId: process.env.DEFAULT_PROJECT_ID ?? "nodex",
  embedModel: process.env.VOYAGE_EMBED_MODEL ?? "voyage-4-large",
  // Contextual embedder (voyage-context-4) for the Wave-P blue/green swap. Used by
  // embedContextual()/embedContextualSingle(); the legacy embedModel stays for the
  // burn-in embed() path. NOT required in assertServerConfig — unset falls back here.
  // context-4 is a drop-in successor to context-3: same endpoint/shape/1024-int8, cheaper
  // ($0.12 vs $0.18 /M) and higher retrieval quality. Vectors are NOT cross-compatible with
  // context-3, so the whole embedding_v2 column must be re-embedded consistently on a swap.
  contextModel: process.env.VOYAGE_CONTEXT_MODEL ?? "voyage-context-4",
  rerankModel: process.env.VOYAGE_RERANK_MODEL ?? "rerank-2.5-lite",
  // recall pool size handed to the reranker (doc: keep 20–25)
  candidatePool: parseInt(process.env.CANDIDATE_POOL ?? "25", 10),
  // Anthropic key + models for the PAID operator scripts (distill-eval now; consolidate
  // in wave-5). Deliberately NOT in assertServerConfig — the MCP server runs without
  // them; src/llm.ts raises a clear message when a script needs the key and it is
  // absent (AC-108). Haiku-class default: cheap judge/distill work.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // Write-time summary gate (src/summarize.ts) — an EXTRA gate beyond the key being
  // present, because compose passes ANTHROPIC_API_KEY through for operator scripts:
  // without this flag, provisioning the key for `consolidate` would silently start
  // spending on every memory_store (write-path-stays-cheap lock, program wave-5
  // design lock). Default off; NOT in assertServerConfig.
  summarizeOnStore: process.env.SUMMARIZE_ON_STORE === "1",
  // `||` (not `??`): compose materializes `${CONSOLIDATE_MODEL:-}` as an EMPTY STRING
  // in-container, and an empty model string 400s at the Anthropic API — empty must
  // fall back exactly like unset (found live, 2026-07-04 backfill all-skip incident).
  consolidateModel: process.env.CONSOLIDATE_MODEL || "claude-haiku-4-5",
  // Eval-candidate distiller model; falls back to the consolidate model.
  distillModel:
    process.env.DISTILL_MODEL ||
    process.env.CONSOLIDATE_MODEL ||
    "claude-haiku-4-5",
  // Origin allowlist (DNS-rebinding guard). Empty = only no-Origin (loopback) passes.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Cloudflare Access (Managed OAuth) — validate Cf-Access-Jwt-Assertion on the public path.
  cfAccessTeamDomain: process.env.CF_ACCESS_TEAM_DOMAIN ?? "",
  cfAccessAud: process.env.CF_ACCESS_AUD ?? "",
};

export function assertServerConfig(): void {
  if (!config.databaseUrl) throw new Error("DATABASE_URL required");
  if (!config.voyageApiKey) throw new Error("VOYAGE_API_KEY required");
}
