export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  masterKey: process.env.SECRETS_MASTER_KEY ?? '',
  port: parseInt(process.env.PORT ?? '8082', 10),
  bearerToken: process.env.MNEMO_TOKEN ?? '',
  defaultProjectId: process.env.DEFAULT_PROJECT_ID ?? 'nodex',
};

export function assertServerConfig(): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL required');
  if (!config.masterKey) throw new Error('SECRETS_MASTER_KEY required (box-local key)');
}
