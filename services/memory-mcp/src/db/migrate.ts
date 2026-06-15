import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

// dist/db/migrate.js  -> ../../sql ;  src/db/migrate.ts (tsx) -> ../../sql
const sqlDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');

async function main(): Promise<void> {
  const files = readdirSync(sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    process.stdout.write(`applying ${f} ... `);
    await pool.query(readFileSync(join(sqlDir, f), 'utf8'));
    console.log('ok');
  }
  await pool.end();
  console.log('migrations complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
