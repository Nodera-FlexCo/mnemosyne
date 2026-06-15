export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  voyageApiKey: process.env.VOYAGE_API_KEY ?? '',
  port: parseInt(process.env.PORT ?? '8081', 10),
  bearerToken: process.env.MNEMO_TOKEN ?? '',
  defaultProjectId: process.env.DEFAULT_PROJECT_ID ?? 'nodex',
  codeEmbedModel: process.env.VOYAGE_CODE_MODEL ?? 'voyage-code-3',
  rerankModel: process.env.VOYAGE_RERANK_MODEL ?? 'rerank-2.5-lite',
  candidatePool: parseInt(process.env.CANDIDATE_POOL ?? '25', 10),
  // repos are mounted read-only here (host /home/development/dev -> /repos)
  reposRoot: process.env.REPOS_ROOT ?? '/repos',
};

export function assertServerConfig(): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL required');
  if (!config.voyageApiKey) throw new Error('VOYAGE_API_KEY required');
}
