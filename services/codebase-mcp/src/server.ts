import { readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  graphExpand,
  tracePath,
  lookupSymbol,
  formatGraphRows,
  type Direction,
} from "./graph/traverse.js";

/** Safe-resolve <reposRoot>/<repo>/<path>, blocking traversal outside reposRoot. */
function resolveRepoPath(repo: string, relPath: string): string | null {
  const root = resolve(config.reposRoot);
  const full = normalize(join(root, repo, relPath));
  return full.startsWith(root + "/") || full === root ? full : null;
}

/**
 * Read a file (or line range) from a repo, line-numbered — the same primitive code_get_file
 * uses, factored out so the graph tools can fall back to it when the graph is empty (AC-009).
 * Returns null when the path is invalid or unreadable.
 */
function readRepoFile(
  repo: string,
  relPath: string,
  startLine?: number,
  endLine?: number,
): string | null {
  const full = resolveRepoPath(repo, relPath);
  if (!full) return null;
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const from = startLine ? startLine - 1 : 0;
  const to = endLine ?? Math.min(lines.length, from + 400);
  const slice = lines.slice(from, to);
  const hasMore = to < lines.length;
  const body = slice.map((l, i) => `${from + i + 1}\t${l}`).join("\n");
  const header = `${repo}/${relPath} (lines ${from + 1}-${to} of ${lines.length})${hasMore ? " — more below; request a higher range" : ""}\n`;
  return (header + body).slice(0, 90_000);
}

export function buildServer(projectId: string): McpServer {
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

  // ── Graph tools (Wave 4). Read-only walks of the AST code graph. Edges are by-name
  //    resolved, so a hop labeled "(name-matched, may be ambiguous)" matched >1 symbol. ──

  server.registerTool(
    "code_graph_expand",
    {
      title: "Expand the code graph around a symbol",
      description:
        "Given a symbol (by name), a file+line, or a chunkId, return its definition plus " +
        "callers and callees from the AST call graph as structured rows " +
        "{name, file:line, depth, edge_type}. Use to answer 'who calls X' / 'what does X call'. " +
        "Falls back to a file read when the graph has no edges for the seed. " +
        "Name-matched (ambiguous) hops are labeled.",
      inputSchema: {
        repo: z
          .string()
          .optional()
          .describe("Repository id (dir name) to scope to"),
        symbol: z.string().optional().describe("Symbol name to seed from"),
        file: z
          .string()
          .optional()
          .describe("File path (with optional line) to seed from"),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Line within file to seed from"),
        chunkId: z
          .string()
          .optional()
          .describe("code_search chunkId to seed from"),
        direction: z
          .enum(["callees", "callers", "both"])
          .optional()
          .default("both")
          .describe("Follow callees, callers, or both (default both)"),
        depth: z.number().int().min(1).max(10).optional().default(4),
        limit: z.number().int().min(1).max(1000).optional().default(50),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repo, symbol, file, line, chunkId, direction, depth, limit }) => {
      try {
        const rows = await graphExpand({
          seed: {
            projectId,
            repo,
            name: symbol,
            file,
            line,
            chunkId,
          },
          direction: direction as Direction,
          depth,
          limit,
        });
        if (rows.length > 0) {
          return { content: [{ type: "text", text: formatGraphRows(rows) }] };
        }
        // AC-009 file-read fallback: no graph edges for this seed (un-graphed repo,
        // non-TS file, or a name with no symbol). Read the file rather than return empty.
        if (repo && file) {
          const body = readRepoFile(repo, file, line);
          if (body) {
            return {
              content: [
                {
                  type: "text",
                  text: `(graph had no edges for this seed — showing the file instead)\n${body}`,
                },
              ],
            };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: "No graph rows and no file to fall back to. Pass repo+file for a file-read fallback, or reindex the repo with force to build the graph.",
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `code_graph_expand failed: ${(e as Error).message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "code_symbol_lookup",
    {
      title: "Look up a symbol definition by name",
      description:
        "Resolve a symbol name to its definition(s): {name, kind, file:line}. When more than " +
        "one match exists the name is ambiguous — all matches are returned with a note.",
      inputSchema: {
        name: z.string().describe("Symbol name to resolve"),
        repo: z
          .string()
          .optional()
          .describe("Repository id (dir name) to scope to"),
        limit: z.number().int().min(1).max(1000).optional().default(50),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, repo, limit }) => {
      try {
        const rows = await lookupSymbol({ projectId, name, repo, limit });
        if (rows.length === 0) {
          return {
            content: [{ type: "text", text: `No symbol named "${name}".` }],
          };
        }
        const note =
          rows.length > 1
            ? `${rows.length} matches for "${name}" (name-matched, may be ambiguous):\n`
            : "";
        const body = rows
          .map((r) => `${r.name} [${r.kind}]  ${r.file}:${r.line}`)
          .join("\n");
        return { content: [{ type: "text", text: note + body }] };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `code_symbol_lookup failed: ${(e as Error).message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "code_trace_path",
    {
      title: "Trace a call path (route → handler → service → repo)",
      description:
        "Trace how a request flows: follow call edges downstream from a seed symbol/file/chunkId " +
        "and return the ordered chain {name, file:line, edge_type, depth}. Pass `to` to stop at a " +
        "target name. Because edges are by-name, this returns A resolved path, not a proven-unique one.",
      inputSchema: {
        repo: z
          .string()
          .optional()
          .describe("Repository id (dir name) to scope to"),
        symbol: z.string().optional().describe("Seed symbol name"),
        file: z
          .string()
          .optional()
          .describe("Seed file path (with optional line)"),
        line: z.number().int().min(1).optional(),
        chunkId: z.string().optional().describe("Seed code_search chunkId"),
        to: z
          .string()
          .optional()
          .describe(
            "Stop at the first symbol with this name (the chain target)",
          ),
        depth: z.number().int().min(1).max(10).optional().default(4),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repo, symbol, file, line, chunkId, to, depth }) => {
      try {
        const { rows, reachedTo } = await tracePath({
          seed: { projectId, repo, name: symbol, file, line, chunkId },
          toName: to,
          depth,
        });
        if (rows.length > 0) {
          const note =
            to && !reachedTo
              ? `(no path to "${to}" within depth ${depth ?? 4})\n`
              : "";
          return {
            content: [{ type: "text", text: note + formatGraphRows(rows) }],
          };
        }
        if (repo && file) {
          const body = readRepoFile(repo, file, line);
          if (body) {
            return {
              content: [
                {
                  type: "text",
                  text: `(graph had no edges for this seed — showing the file instead)\n${body}`,
                },
              ],
            };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: "No path found and no file to fall back to.",
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `code_trace_path failed: ${(e as Error).message}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

// Bootstrap the HTTP transport only when run as the entrypoint — guarded (like indexer.ts)
// so importing buildServer from tests does not assert env / bind a port.
function bootstrap(): void {
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  bootstrap();
}
