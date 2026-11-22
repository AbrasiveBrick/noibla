// HTTP transport, as two separate listeners. The bot listener serves
// POST /api/command and GET /api/events (SSE) with a bot token. The operator
// listener serves the dashboard, GET /operator/state and GET /operator/agent
// (one agent's transcript) with the operator token, on its own port so sandboxed agents can be given the bot port only.
// The two credentials are distinct and never interchangeable.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../shared/catalog.ts';
import { MAP_RULES } from '../shared/map.ts';
import type { GameEvent } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import { GameError } from './util.ts';
import { operatorState } from './operator.ts';
import { readTranscript } from './transcript.ts';

const DASHBOARD = fileURLToPath(new URL('./dashboard.html', import.meta.url));
const SDK_DOC = fileURLToPath(new URL('../../docs/SDK.md', import.meta.url));
const MAX_BODY = 64 * 1024;

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new GameError('BAD_REQUEST', 'body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GameError('BAD_REQUEST', 'invalid JSON'); }
}

export type Listener = 'bot' | 'operator';

/** `agentLogDir`: where the sandbox launcher keeps agent transcripts. Only the operator listener reads it. */
export function createHttpServer(game: Game, listener: Listener, agentLogDir?: string): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (listener === 'operator') return await handleOperator(game, req, res, url, agentLogDir);
      if (req.method === 'GET' && path === '/') return send(res, 200, 'noibla bot API. Read GET /docs/sdk.');

      if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, now: game.now(), speed: game.speed });
      if (req.method === 'GET' && path === '/api/catalog') return send(res, 200, { ...CATALOG, map: { ...MAP_RULES, ...game.map } });
      if (req.method === 'GET' && path === '/docs/sdk') return send(res, 200, readFileSync(SDK_DOC, 'utf8'), { 'content-type': 'text/markdown; charset=utf-8' });

      if (req.method === 'POST' && path === '/api/register') {
        const body = await readJson(req);
        try { return send(res, 201, game.register(body?.name)); }
        catch (e) { if (e instanceof GameError) return send(res, e.code === 'NAME_TAKEN' ? 409 : 400, { ok: false, error: { code: e.code, message: e.message } }); throw e; }
      }

      if (path === '/api/command' && req.method === 'POST') {
        const player = game.authBot(bearer(req));
        if (!player) return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or invalid bot token' } });
        let body: any;
        try { body = await readJson(req); }
        catch (e) { return send(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: (e as Error).message } }); }
        return send(res, 200, game.execute(player.id, body ?? {}));
      }

      if (path === '/api/events' && req.method === 'GET') {
        const player = game.authBot(bearer(req));
        if (!player) return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or invalid bot token' } });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 1000\n\n');
        const write = (ev: GameEvent) => { res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); };
        const unsubscribe = game.subscribe({ kind: 'player', playerId: player.id, send: write });
        const heartbeat = setInterval(() => res.write(': hb\n\n'), 15_000);
        res.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }

      notFound(res, req, path);
    } catch (e) {
      game.log(`[http-error] ${req.method} ${path} ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'internal server error' } });
      else res.end();
    }
  });
}

function notFound(res: ServerResponse, req: IncomingMessage, path: string) {
  send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `no route ${req.method} ${path}` } });
}

async function handleOperator(game: Game, req: IncomingMessage, res: ServerResponse, url: URL, agentLogDir?: string): Promise<void> {
  const path = url.pathname;
  if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'" });
    res.end(readFileSync(DASHBOARD));
    return;
  }
  if (req.method === 'GET' && path === '/operator/state') {
    if (!game.authOperator(bearer(req))) return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'operator credential required' } });
    const since = Number(url.searchParams.get('since') ?? '0') || 0;
    const snap = Number(url.searchParams.get('snap') ?? '0') || 0;
    return send(res, 200, operatorState(game, since, snap));
  }
  if (req.method === 'GET' && path === '/operator/agent') {
    if (!game.authOperator(bearer(req))) return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'operator credential required' } });
    const player = game.players.get(url.searchParams.get('id') ?? '');
    if (!player) return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such player' } });
    const offset = (key: string) => {
      const raw = url.searchParams.get(key);
      const n = Number(raw);
      return raw && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
    };
    // A sandboxed agent plays under the name it was launched with, which is also its transcript's name. After a death it
    // goes on as <name>-2 and so on, in the same transcript.
    const at = { after: offset('after'), before: offset('before') };
    let transcript = agentLogDir ? readTranscript(agentLogDir, player.name, at) : { found: false, items: [], from: 0, to: 0 };
    const launched = player.name.replace(/-\d+$/, '');
    if (agentLogDir && !transcript.found && launched !== player.name) transcript = readTranscript(agentLogDir, launched, at);
    return send(res, 200, transcript);
  }
  notFound(res, req, path);
}
