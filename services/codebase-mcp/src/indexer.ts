import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ignore from 'ignore';
import { pool } from './db/pool.js';
import { config } from './config.js';
import { chunkFile, languageFor, fileSha256 } from './chunker.js';
import { embedCode, toVectorLiteral } from './voyage.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage',
  'vendor', '.venv', '__pycache__', '.idea', '.vscode', '.nx', 'out', '.svelte-kit',
]);
const MAX_FILE_BYTES = 400_000;
const EMBED_BATCH = 64;

function walk(dir: string, ig: ReturnType<typeof ignore>, base: string, out: string[]): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    const rel = relative(base, full);
    if (rel && ig.ignores(rel)) continue;
    if (e.isDirectory()) walk(full, ig, base, out);
    else if (e.isFile()) out.push(full);
  }
}

async function indexRepo(repoDir: string, repositoryId: string, projectId: string): Promise<void> {
  const base = resolve(repoDir);
  const ig = ignore();
  for (const f of ['.gitignore', '.indexignore']) {
    try { ig.add(readFileSync(join(base, f), 'utf8')); } catch { /* none */ }
  }
  ig.add(['secrets/', '*.pem', '*.key', '*.min.js', '*.lock', 'pnpm-lock.yaml', 'package-lock.json']);

  const files: string[] = [];
  walk(base, ig, base, files);
  console.error(`scanning ${repositoryId}: ${files.length} candidate files`);

  let indexed = 0, skipped = 0, chunksTotal = 0;
  for (const full of files) {
    const lang = languageFor(full);
    if (!lang) { continue; }
    let st; try { st = statSync(full); } catch { continue; }
    if (st.size === 0 || st.size > MAX_FILE_BYTES) { skipped++; continue; }
    const rel = relative(base, full);
    let content; try { content = readFileSync(full, 'utf8'); } catch { continue; }
    const fhash = fileSha256(content);

    const existing = await pool.query<{ content_sha256: string }>(
      'SELECT content_sha256 FROM codebase.files WHERE repository_id=$1 AND path=$2',
      [repositoryId, rel],
    );
    if (existing.rows[0]?.content_sha256 === fhash) { skipped++; continue; }

    const chunks = chunkFile(content);
    if (chunks.length === 0) { skipped++; continue; }

    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      vectors.push(...(await embedCode(chunks.slice(i, i + EMBED_BATCH).map((c) => c.content), 'document')));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fr = await client.query<{ id: string }>(
        `INSERT INTO codebase.files (repository_id, project_id, path, language, content_sha256)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (repository_id, path)
           DO UPDATE SET content_sha256=EXCLUDED.content_sha256, language=EXCLUDED.language, indexed_at=now()
         RETURNING id`,
        [repositoryId, projectId, rel, lang, fhash],
      );
      const fileId = fr.rows[0].id;
      await client.query('DELETE FROM codebase.code_chunks WHERE file_id=$1', [fileId]);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await client.query(
          `INSERT INTO codebase.code_chunks
             (file_id,repository_id,project_id,file_path,language,symbol_name,symbol_kind,start_line,end_line,content,content_sha256,embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::halfvec)`,
          [fileId, repositoryId, projectId, rel, lang, c.symbolName, c.symbolKind,
           c.startLine, c.endLine, c.content, c.contentSha256, toVectorLiteral(vectors[i])],
        );
        chunksTotal++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    indexed++;
    if (indexed % 25 === 0) console.error(`  ${indexed} files, ${chunksTotal} chunks...`);
  }
  console.error(`done ${repositoryId}: ${indexed} indexed, ${skipped} skipped, ${chunksTotal} chunks total`);
}

// CLI: node dist/indexer.js <repoDirOrName> [projectId] [repositoryId]
const arg = process.argv[2];
if (!arg) {
  console.error('usage: indexer <repoDirName|absPath> [projectId] [repositoryId]');
  process.exit(1);
}
const repoDir = arg.startsWith('/') ? arg : join(config.reposRoot, arg);
const projectId = process.argv[3] ?? config.defaultProjectId;
const repositoryId = process.argv[4] ?? arg.replace(/\/+$/, '').split('/').pop()!;
indexRepo(repoDir, repositoryId, projectId)
  .then(() => pool.end())
  .catch((e) => { console.error(e); process.exit(1); });
