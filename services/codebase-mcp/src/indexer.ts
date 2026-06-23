import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pool } from "./db/pool.js";
import { config } from "./config.js";
import { chunkFile, languageFor, fileSha256 } from "./chunker.js";
import { embedCode, toVectorLiteral } from "./voyage.js";

interface Ignorer {
  add(pattern: string | string[]): Ignorer;
  ignores(path: string): boolean;
}
const ignore = createRequire(import.meta.url)("ignore") as () => Ignorer;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
  ".nx",
  "out",
  ".svelte-kit",
]);
const MAX_FILE_BYTES = 400_000;
const EMBED_BATCH = 64;

function walk(
  dir: string,
  ig: ReturnType<typeof ignore>,
  base: string,
  out: string[],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    const rel = relative(base, full);
    if (rel && ig.ignores(rel)) continue;
    if (e.isDirectory()) walk(full, ig, base, out);
    else if (e.isFile()) out.push(full);
  }
}

/** Open an index_runs row at the start of a run. Returns its id. */
async function startRun(
  repositoryId: string,
  projectId: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO codebase.index_runs (project_id, repository_id, phase)
     VALUES ($1, $2, 'scanning') RETURNING id`,
    [projectId, repositoryId],
  );
  return rows[0].id;
}

/** Best-effort progress update; never throws (it must not mask indexing work). */
async function updateRun(
  runId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  try {
    await pool.query(`UPDATE codebase.index_runs SET ${sets} WHERE id = $1`, [
      runId,
      ...keys.map((k) => fields[k]),
    ]);
  } catch (e) {
    console.error(
      `[index_runs] update failed for ${runId}:`,
      (e as Error).message,
    );
  }
}

/** Has a cooperative cancel been requested for this run? */
async function cancelRequested(runId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ cancel_requested: boolean }>(
      "SELECT cancel_requested FROM codebase.index_runs WHERE id = $1",
      [runId],
    );
    return rows[0]?.cancel_requested === true;
  } catch {
    return false;
  }
}

export async function indexRepo(
  repoDir: string,
  repositoryId: string,
  projectId: string,
): Promise<void> {
  const runId = await startRun(repositoryId, projectId);
  try {
    const base = resolve(repoDir);
    const ig = ignore();
    for (const f of [".gitignore", ".indexignore"]) {
      try {
        ig.add(readFileSync(join(base, f), "utf8"));
      } catch {
        /* none */
      }
    }
    ig.add([
      "secrets/",
      "*.pem",
      "*.key",
      "*.min.js",
      "*.lock",
      "pnpm-lock.yaml",
      "package-lock.json",
    ]);

    const files: string[] = [];
    walk(base, ig, base, files);
    console.error(`scanning ${repositoryId}: ${files.length} candidate files`);
    await updateRun(runId, { files_total: files.length, files_done: 0 });

    let indexed = 0,
      skipped = 0,
      chunksTotal = 0,
      cancelled = false;
    for (const full of files) {
      if (await cancelRequested(runId)) {
        cancelled = true;
        break;
      }
      const lang = languageFor(full);
      if (!lang) {
        continue;
      }
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size === 0 || st.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      const rel = relative(base, full);
      let content;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const fhash = fileSha256(content);

      const existing = await pool.query<{ content_sha256: string }>(
        "SELECT content_sha256 FROM codebase.files WHERE repository_id=$1 AND path=$2",
        [repositoryId, rel],
      );
      if (existing.rows[0]?.content_sha256 === fhash) {
        skipped++;
        continue;
      }

      const chunks = chunkFile(content);
      if (chunks.length === 0) {
        skipped++;
        continue;
      }

      await updateRun(runId, { phase: "embedding", current_file: rel });
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        vectors.push(
          ...(await embedCode(
            chunks.slice(i, i + EMBED_BATCH).map((c) => c.content),
            "document",
          )),
        );
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const fr = await client.query<{ id: string }>(
          `INSERT INTO codebase.files (repository_id, project_id, path, language, content_sha256)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (repository_id, path)
             DO UPDATE SET content_sha256=EXCLUDED.content_sha256, language=EXCLUDED.language, indexed_at=now()
           RETURNING id`,
          [repositoryId, projectId, rel, lang, fhash],
        );
        const fileId = fr.rows[0].id;
        await client.query(
          "DELETE FROM codebase.code_chunks WHERE file_id=$1",
          [fileId],
        );
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          await client.query(
            `INSERT INTO codebase.code_chunks
               (file_id,repository_id,project_id,file_path,language,symbol_name,symbol_kind,start_line,end_line,content,content_sha256,embedding)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::halfvec)`,
            [
              fileId,
              repositoryId,
              projectId,
              rel,
              lang,
              c.symbolName,
              c.symbolKind,
              c.startLine,
              c.endLine,
              c.content,
              c.contentSha256,
              toVectorLiteral(vectors[i]),
            ],
          );
          chunksTotal++;
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      indexed++;
      if (indexed % 25 === 0) {
        console.error(`  ${indexed} files, ${chunksTotal} chunks...`);
        await updateRun(runId, {
          files_done: indexed,
          chunks_total: chunksTotal,
        });
      }
    }
    console.error(
      `done ${repositoryId}: ${indexed} indexed, ${skipped} skipped, ${chunksTotal} chunks total`,
    );
    await updateRun(runId, {
      phase: "done",
      files_done: indexed,
      chunks_total: chunksTotal,
      current_file: null,
      error: cancelled ? "cancelled by request" : null,
      finished_at: new Date(),
    });
  } catch (e) {
    // Detached process: this row is the ONLY failure signal. Keep the error-write
    // defensive so a DB error during error-handling can't mask the original throw.
    const message = (e as Error).message ?? String(e);
    try {
      await pool.query(
        `UPDATE codebase.index_runs
         SET phase='error', error=$2, finished_at=now()
         WHERE id=$1`,
        [runId, message],
      );
    } catch (writeErr) {
      console.error(
        "[index_runs] failed to record error row:",
        (writeErr as Error).message,
      );
    }
    throw e;
  }
}

// CLI: node dist/indexer.js <repoDirOrName> [projectId] [repositoryId]
// Guarded so importing this module (e.g. from tests) does not auto-run the CLI.
function runCli(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "usage: indexer <repoDirName|absPath> [projectId] [repositoryId]",
    );
    process.exit(1);
  }
  const repoDir = arg.startsWith("/") ? arg : join(config.reposRoot, arg);
  const projectId = process.argv[3] ?? config.defaultProjectId;
  const repositoryId =
    process.argv[4] ?? arg.replace(/\/+$/, "").split("/").pop()!;
  indexRepo(repoDir, repositoryId, projectId)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
