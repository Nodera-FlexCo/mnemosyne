import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config, assertServerConfig } from './config.js';
import { requireBearer, type MnemoAuth } from './auth.js';
import { originGuard } from './origin.js';
import * as mem from './memory.js';

const MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'entity'] as const;

function buildServer(projectId: string): McpServer {
  const server = new McpServer({ name: 'memory-mcp-server', version: '1.0.0' });

  server.registerTool(
    'memory_search',
    {
      title: 'Search long-term memory',
      description:
        'Hybrid (semantic + lexical) search over durable cross-session memory. ' +
        'Returns compact top-k {id, title, type, snippet}. Use for "what did we decide about X". ' +
        'Fetch full text with memory_get using a returned id.',
      inputSchema: {
        query: z.string().describe('What to recall'),
        type: z.enum(MEMORY_TYPES).optional().describe('Restrict to one memory type'),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, type, limit }) => {
      try {
        const hits = await mem.searchMemory({ projectId, query, type, limit });
        return { content: [{ type: 'text', text: mem.formatHits(hits) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `memory_search failed: ${(e as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    'memory_store',
    {
      title: 'Store a distilled memory',
      description:
        'Persist a DISTILLED fact/decision/learning (not raw transcript). Call when a durable ' +
        'decision is made or the user says "remember this".',
      inputSchema: {
        type: z.enum(MEMORY_TYPES).describe('episodic=what happened, semantic=durable fact/decision, procedural=how-to, entity=person/project/issue'),
        title: z.string().describe('Short headline'),
        content: z.string().describe('The distilled fact, markdown ok'),
        importance: z.number().min(0).max(1).default(0.5),
        sourceKind: z.string().optional().describe('Category for enumeration: tech-debt, research, plan, audit, decision, implementation, requirements, copywrite'),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.any()).optional().describe('Structured fields, e.g. tech-debt: {debtId, severity, category, file}'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ type, title, content, importance, sourceKind, tags, metadata }) => {
      try {
        const r = await mem.storeMemory({
          projectId, type, title, content, importance, sourceKind,
          metadata: { ...(metadata ?? {}), ...(tags ? { tags } : {}) },
        });
        return { content: [{ type: 'text', text: `stored ${type} memory "${r.title}" (id: ${r.id})` }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `memory_store failed: ${(e as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    'memory_get',
    {
      title: 'Fetch a memory by id',
      description: 'Return the full body of one memory (bumps its access count).',
      inputSchema: { id: z.string().describe('Memory id from a search result') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const row = await mem.getMemory(id);
      if (!row) return { isError: true, content: [{ type: 'text', text: `no memory ${id}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    },
  );

  server.registerTool(
    'memory_get_recent',
    {
      title: 'Recent memories',
      description: 'List the most recently created memories for this project.',
      inputSchema: {
        type: z.enum(MEMORY_TYPES).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ type, limit }) => {
      const hits = await mem.getRecent({ projectId, type, limit });
      return { content: [{ type: 'text', text: mem.formatHits(hits) }] };
    },
  );

  server.registerTool(
    'memory_update',
    {
      title: 'Edit / re-score a memory',
      description: 'Update fields of an existing memory (re-embeds if title/content change).',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        content: z.string().optional(),
        importance: z.number().min(0).max(1).optional(),
        pinned: z.boolean().optional(),
        status: z.string().optional().describe('active | resolved | superseded | archived | closed — e.g. set "resolved" when a tech-debt item is fixed'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id, ...fields }) => {
      const r = await mem.updateMemory(id, fields);
      if (!r) return { isError: true, content: [{ type: 'text', text: `no memory ${id}` }] };
      return { content: [{ type: 'text', text: `updated ${r.id}` }] };
    },
  );

  server.registerTool(
    'memory_list',
    {
      title: 'List / enumerate memories (structured, not search)',
      description:
        'Enumerate + COUNT memories by source_kind / type / status / tag, newest first. ' +
        'Use for "list all open tech debts", "which implementations shipped", "count research". ' +
        'Returns compact rows + counts (X active / Y resolved / Z total). ' +
        'This is NOT semantic search — for "what did we decide about X" use memory_search.',
      inputSchema: {
        sourceKind: z.string().optional().describe('e.g. tech-debt, research, plan, audit, decision, implementation'),
        type: z.enum(MEMORY_TYPES).optional(),
        status: z.string().optional().describe('active (default) | resolved | superseded | all'),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sourceKind, type, status, tag, limit }) => {
      const r = await mem.listMemories({ projectId, sourceKind, type, status, tag, limit });
      const header = `${r.rows.length} shown · ${r.active} active / ${r.resolved} resolved / ${r.total} total${sourceKind ? ` [${sourceKind}]` : ''}`;
      const body = r.rows.map((m) => `• [${m.status}] ${m.title}  (${m.source_kind ?? m.type}, id: ${m.id})`).join('\n');
      return { content: [{ type: 'text', text: `${header}\n${body || '(none)'}` }] };
    },
  );

  server.registerTool(
    'memory_delete',
    {
      title: 'Archive (soft-delete) a memory',
      description: 'Soft-delete a memory (excluded from search, recoverable).',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
    },
    async ({ id }) => {
      const ok = await mem.archiveMemory(id);
      return { content: [{ type: 'text', text: ok ? `archived ${id}` : `nothing to archive for ${id}` }] };
    },
  );

  server.registerTool(
    'memory_get_entity',
    {
      title: 'Fetch an entity + relationships',
      description: 'Look up a tracked entity (person/project/Linear issue/repo) and its edges.',
      inputSchema: { nameOrId: z.string().describe('Entity name or id') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ nameOrId }) => {
      const row = await mem.getEntity({ projectId, nameOrId });
      if (!row) return { isError: true, content: [{ type: 'text', text: `no entity "${nameOrId}"` }] };
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    },
  );

  return server;
}

assertServerConfig();

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'memory-mcp-server' });
});

app.use(originGuard);
app.use(requireBearer);

app.post('/mcp', async (req, res) => {
  const auth = (req as express.Request & { auth?: MnemoAuth }).auth;
  const projectId = auth?.extra.projectId ?? config.defaultProjectId;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => void transport.close());
  const server = buildServer(projectId);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(config.port, '0.0.0.0', () => {
  console.error(`memory-mcp-server listening on :${config.port}`);
});
