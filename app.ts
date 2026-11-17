// The forge's HTTP server: health probe, REST v3, GraphQL v4, MCP and git smart HTTP.
// main.ts owns the entry <-> env lifecycle and stays as it is; this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { checkAuth, handleRest, type Ctx } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-length': 0, ...headers });
  res.end();
}

/** Answer with raw bytes (git smart HTTP); `contentType` is the git content type. */
function sendRaw(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the request body (up to the cap); null when it is past it. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const requestId = store.nextRequestId();

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, { 'x-github-request-id': requestId });
        return;
      }

      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { message: 'Request body too large' }, { 'x-github-request-id': requestId });
        return;
      }

      const segments = path.split('/').filter((seg) => seg !== '');
      const ctx: Ctx = {
        store,
        method,
        segments,
        query: queryOf(req),
        headers: req.headers,
        host: req.headers.host ?? 'localhost',
        bodyText: body.toString('utf8'),
      };

      // /mcp — Model Context Protocol (auth required; POST JSON-RPC, DELETE closes a session).
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method === 'DELETE') {
          sendEmpty(res, 200, { 'x-github-request-id': requestId });
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
          return;
        }
        const reply = handleMcp(ctx);
        if (reply) {
          if (reply.json === null) {
            sendEmpty(res, reply.status, { 'x-github-request-id': requestId, ...reply.headers });
          } else {
            sendJson(res, reply.status, reply.json, { 'x-github-request-id': requestId, ...reply.headers });
          }
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
        return;
      }

      // /{owner}/{repo}.git/... — git smart HTTP (v2 upload-pack, v0 receive-pack).
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const git = handleGit(ctx, body);
        if (git) {
          sendRaw(res, git.status, git.contentType, git.body, { 'x-github-request-id': requestId });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
        return;
      }

      // /api/graphql — GraphQL v4 (auth required; POST JSON {query, variables} or a batch array).
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        const auth = checkAuth(ctx);
        if (auth) {
          sendJson(res, auth.status, auth.json, { 'x-github-request-id': requestId });
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
          return;
        }
        const reply = handleGraphql(ctx);
        sendJson(res, reply.status, reply.json, { 'x-github-request-id': requestId });
        return;
      }

      // /api/v3/... — REST v3 (auth required on every route).
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const auth = checkAuth(ctx);
        if (auth) {
          sendJson(res, auth.status, auth.json, { 'x-github-request-id': requestId });
          return;
        }
        const restCtx: Ctx = { ...ctx, segments: segments.slice(2) };
        const reply = handleRest(restCtx);
        if (reply) {
          if (reply.json === null) {
            sendEmpty(res, reply.status, { 'x-github-request-id': requestId, ...reply.headers });
          } else {
            sendJson(res, reply.status, reply.json, { 'x-github-request-id': requestId, ...reply.headers });
          }
          return;
        }
        // Unknown /api/v3 route: JSON 404.
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
    })().catch(() => {
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is already gone; nothing to do.
      }
    });
  });
}
