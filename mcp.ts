// MCP (Model Context Protocol) over Streamable HTTP at POST /mcp.
// Plain JSON answers (no SSE needed): the kit's client accepts a single JSON body.
// Modern 2026-07-28 revision via `server/discover`, plus the legacy `initialize`
// handshake. Every call shares the REST store, so MCP and REST see the same objects.

import {
  checkAuth,
  createIssueRecord,
  createPullRecord,
  issueJson,
  mergePullRecord,
  pullJson,
  repoJson,
  type Ctx,
  type Reply,
} from './rest.ts';
import { VIEWER, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

type ToolRun = (store: Store, args: Record<string, unknown>) => { result: unknown } | { error: string };

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
  run: ToolRun;
}

function strArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string) : '';
}

function replyMessage(reply: Reply): string {
  const json = reply.json as { message?: unknown } | null;
  return json && typeof json.message === 'string' && json.message !== '' ? json.message : 'error';
}

function getRepoArg(store: Store, args: Record<string, unknown>): { owner: string; name: string; repo: NonNullable<ReturnType<Store['getRepo']>> } | { error: string } {
  const owner = strArg(args, 'owner');
  const name = strArg(args, 'repo');
  const repo = owner !== '' && name !== '' ? store.getRepo(owner, name) : undefined;
  if (!repo) return { error: `Repository ${owner}/${name} not found` };
  return { owner, name, repo };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    run: (store, args) => {
      const name = strArg(args, 'name');
      if (name === '') return { error: 'name is required' };
      if (store.getRepo(VIEWER.login, name)) return { error: `Repository ${VIEWER.login}/${name} already exists` };
      const repo = store.createRepo(VIEWER.login, name, {
        private: typeof args.private === 'boolean' ? args.private : false,
        description: strArg(args, 'description'),
      });
      return { result: repoJson(store, repo) };
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    run: (store, args) => {
      const found = getRepoArg(store, args);
      if ('error' in found) return { error: found.error };
      return { result: repoJson(store, found.repo) };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    run: (store, args) => {
      const found = getRepoArg(store, args);
      if ('error' in found) return { error: found.error };
      const title = strArg(args, 'title');
      if (title === '') return { error: 'title is required' };
      const created = createIssueRecord(store, found.repo, title, strArg(args, 'body'), []);
      if ('error' in created) return { error: replyMessage(created.error) };
      return { result: issueJson(found.repo, created.issue) };
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    run: (store, args) => {
      const found = getRepoArg(store, args);
      if ('error' in found) return { error: found.error };
      const state = strArg(args, 'state') || 'open';
      let list = [...found.repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.number - a.number);
      return { result: list.map((i) => issueJson(found.repo, i)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    run: (store, args) => {
      const found = getRepoArg(store, args);
      if ('error' in found) return { error: found.error };
      const created = createPullRecord(store, found.repo, {
        title: strArg(args, 'title'),
        body: strArg(args, 'body'),
        head: strArg(args, 'head'),
        base: strArg(args, 'base'),
      });
      if ('error' in created) return { error: replyMessage(created.error) };
      return { result: pullJson(store, found.repo, created.pull) };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    run: (store, args) => {
      const found = getRepoArg(store, args);
      if ('error' in found) return { error: found.error };
      const n = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isInteger(n)) return { error: 'pull_number is required' };
      const merged = mergePullRecord(store, found.repo, n);
      if ('error' in merged) return { error: replyMessage(merged.error) };
      return { result: { sha: merged.sha, merged: true, message: 'Pull request successfully merged', number: n } };
    },
  },
];

/** The tools array, built once: tools/list must be byte-identical across calls. */
const TOOLS_LIST: unknown[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(t.properties).map(([k, v]) => [k, { type: v.type, description: v.description }]),
    ),
    required: t.required,
  },
}));

function rpcResult(id: unknown, result: unknown): Reply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): Reply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Handle one POST /mcp request. Returns null only when the method is not POST. */
export function handleMcp(ctx: Ctx): Reply | null {
  if (ctx.method !== 'POST') return null;

  const auth = checkAuth(ctx);
  if (auth) return { status: 401, json: auth.json };

  let body: unknown;
  try {
    body = JSON.parse(ctx.bodyText);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as Record<string, unknown>;
  const id = 'id' in req ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = typeof req.params === 'object' && req.params !== null ? (req.params as Record<string, unknown>) : {};

  // Notifications carry no id: acknowledge with an empty 202.
  if (id === null || id === undefined) {
    return { status: 202, json: null };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: 'GitHub-compatible git forge: repositories, issues, pull requests and git over MCP tools.',
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
      ? (params.protocolVersion as string)
      : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS_LIST });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
    if (name === '') return rpcError(id, -32602, 'Tool name is required');
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const missing = tool.required.filter((key) => {
      const v = args[key];
      if (v === undefined || v === null) return true;
      if (typeof v === 'string' && v === '') return true;
      return false;
    });
    if (missing.length > 0) {
      return rpcResult(id, toolError(`Missing required argument: ${missing.join(', ')}`));
    }
    const outcome = tool.run(ctx.store, args);
    if ('error' in outcome) return rpcResult(id, toolError(outcome.error));
    return rpcResult(id, toolResult(outcome.result));
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
