import { readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config, assertServerConfig } from "./config.js";
import { requireBearer, type MnemoAuth } from "./auth.js";
import { originGuard } from "./origin.js";
import { pool } from "./db/pool.js";
import { searchCode, formatHits } from "./search.js";
import {
  formatIndexStatus,
  type ChunkAggRow,
  type IndexRunRow,
} from "./status-format.js";

/** Safe-resolve <reposRoot>/<repo>/<path>, blocking traversal outside reposRoot. */
function resolveRepoPath(repo: string, relPath: string): string | null {
  const root = resolve(config.reposRoot);
  const full = normalize(join(root, repo, relPath));
  return full.startsWith(root + "/") || full === root ? full : null;
}

function buildServer(projectId: string): McpServer {
  const server = new McpServer({
    name: "codebase-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "code_search",
    {
      title: "Semantic + lexical code search",
      description:
        "Find code by meaning AND exact tokens. Returns top-k {file:line, symbol, chunkId, snippet}. " +
        'Use when grep is insufficient — "where is auth handled", "how do we validate X". ' +
        "Fetch full bodies with code_get_file using the returned path + range.",
      inputSchema: {
        query: z.string().describe("Natural-language or code query"),
        repo: z
          .string()
          .optional()
          .describe("Repository id (dir name) to scope to"),
        language: z.string().optional(),
        k: z.number().int().min(1).max(20).default(5),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, repo, language, k }) => {
      try {
        const hits = await searchCode({ projectId, query, repo, language, k });
        return { content: [{ type: "text", text: formatHits(hits) }] };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `code_search failed: ${(e as Error).message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "code_get_file",
    {
      title: "Read a file (or line range)",
      description:
        "Return a file or a line range from an indexed repo. Always pass a range for large files.",
      inputSchema: {
        repo: z.string().describe("Repository id (dir name)"),
        path: z.string().describe("File path relative to the repo root"),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repo, path, startLine, endLine }) => {
      const full = resolveRepoPath(repo, path);
      if (!full)
        return {
          isError: true,
          content: [{ type: "text", text: "invalid path" }],
        };
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: `cannot read ${repo}/${path}` }],
        };
      }
      const lines = text.split("\n");
      const from = startLine ? startLine - 1 : 0;
      const to = endLine ?? Math.min(lines.length, from + 400); // default cap 400 lines
      const slice = lines.slice(from, to);
      const hasMore = to < lines.length;
      const body = slice.map((l, i) => `${from + i + 1}\t${l}`).join("\n");
      const header = `${repo}/${path} (lines ${from + 1}-${to} of ${lines.length})${hasMore ? " — more below; request a higher range" : ""}\n`;
      return {
        content: [{ type: "text", text: header + body.slice(0, 90_000) }],
      };
    },
  );

  server.registerTool(
    "code_index_status",
    {
      title: "Indexing status",
      description: "Per-repo file/chunk counts and last index time.",
      inputSchema: { repo: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repo }) => {
      const params: unknown[] = [projectId];
      let filt = "";
      if (repo) {
        params.push(repo);
        filt = "AND repository_id = $2";
      }
      const { rows } = await pool.query(
        `SELECT repository_id,
                count(DISTINCT file_id) AS files,
                count(*) AS chunks,
                max((SELECT indexed_at FROM codebase.files f WHERE f.id = c.file_id)) AS last_indexed
         FROM codebase.code_chunks c
         WHERE project_id = $1 ${filt}
         GROUP BY repository_id ORDER BY repository_id`,
        params,
      );

      // Latest index_runs row per repo (a repo may have a run but zero chunks yet
      // — an in-progress first index — so this is merged in below, not inner-joined).
      const { rows: runRows } = await pool.query<IndexRunRow>(
        `SELECT DISTINCT ON (repository_id)
                repository_id, phase, files_done, files_total, chunks_total,
                current_file, error, started_at, finished_at
         FROM codebase.index_runs
         WHERE project_id = $1 ${filt}
         ORDER BY repository_id, started_at DESC`,
        params,
      );

      const text = formatIndexStatus(rows as ChunkAggRow[], runRows);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "code_reindex",
    {
      title: "Trigger (re)index of a repo",
      description:
        "Kick off background indexing of a repo dir under the repos root. Runs detached " +
        "(fire-and-forget) — poll code_index_status for the result. " +
        "Pass force:true to bypass the content-hash skip so an ALREADY-indexed corpus " +
        "gets its code graph (symbols + edges) built on first rollout; forced runs are " +
        "graph-only for unchanged files (no re-embed, so no Voyage quota burn).",
      inputSchema: {
        repo: z.string().describe("Repository dir name under repos root"),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Bypass the content_sha256 skip to backfill the graph on an already-indexed corpus",
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ repo, force }) => {
      const child = spawn(
        "node",
        [join(import.meta.dirname, "indexer.js"), repo, projectId],
        {
          detached: true,
          stdio: "ignore",
          env: force ? { ...process.env, FORCE_GRAPH: "1" } : process.env,
        },
      );
      child.unref();
      return {
        content: [
          {
            type: "text",
            text: `reindex of "${repo}"${force ? " (force-graph)" : ""} started in background — poll code_index_status for progress`,
          },
        ],
      };
    },
  );

  return server;
}

assertServerConfig();
const app = express();
app.use(express.json({ limit: "4mb" }));
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "codebase-mcp-server" });
});
app.use(originGuard);
app.use(requireBearer);
app.post("/mcp", async (req, res) => {
  const auth = (req as express.Request & { auth?: MnemoAuth }).auth;
  const projectId = auth?.extra.projectId ?? config.defaultProjectId;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => void transport.close());
  const server = buildServer(projectId);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(config.port, "0.0.0.0", () => {
  console.error(`codebase-mcp-server listening on :${config.port}`);
});
