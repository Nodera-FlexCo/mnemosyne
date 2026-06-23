export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  port: parseInt(process.env.PORT ?? "8081", 10),
  bearerToken: process.env.MNEMO_TOKEN ?? "",
  defaultProjectId: process.env.DEFAULT_PROJECT_ID ?? "nodex",
  codeEmbedModel: process.env.VOYAGE_CODE_MODEL ?? "voyage-code-3",
  // Contextual code embedder (voyage-context-3) for the Wave 5 bake-off arm. Used by
  // embedCodeContextual(); the incumbent codeEmbedModel stays the live default until the
  // bake-off picks a winner and the operator flips VOYAGE_CODE_MODEL. NOT required in
  // assertServerConfig — unset falls back here.
  codeContextModel: process.env.VOYAGE_CODE_CONTEXT_MODEL ?? "voyage-context-3",
  rerankModel: process.env.VOYAGE_RERANK_MODEL ?? "rerank-2.5-lite",
  candidatePool: parseInt(process.env.CANDIDATE_POOL ?? "25", 10),
  // repos are mounted read-only here (host /home/development/dev -> /repos)
  reposRoot: process.env.REPOS_ROOT ?? "/repos",
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
