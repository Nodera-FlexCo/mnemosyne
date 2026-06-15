export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  voyageApiKey: process.env.VOYAGE_API_KEY ?? '',
  port: parseInt(process.env.PORT ?? '8080', 10),
  // If unset, the server runs open (fine for localhost-only). Set in prod.
  bearerToken: process.env.MNEMO_TOKEN ?? '',
  defaultProjectId: process.env.DEFAULT_PROJECT_ID ?? 'nodex',
  embedModel: process.env.VOYAGE_EMBED_MODEL ?? 'voyage-4-large',
  rerankModel: process.env.VOYAGE_RERANK_MODEL ?? 'rerank-2.5-lite',
  // recall pool size handed to the reranker (doc: keep 20–25)
  candidatePool: parseInt(process.env.CANDIDATE_POOL ?? '25', 10),
};

export function assertServerConfig(): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL required');
  if (!config.voyageApiKey) throw new Error('VOYAGE_API_KEY required');
}
