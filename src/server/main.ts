// Server entrypoint.
//   PORT=7777 WORLD_SPEED=1 DB_PATH=data/world.db OPERATOR_TOKEN=... node src/server/main.ts

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { Game, type GameOptions } from './game.ts';
import { createHttpServer } from './http.ts';

export interface RunningServer { game: Game; http: Server; url: string; operatorToken: string; stop: () => Promise<void> }

/** Loads OPERATOR_TOKEN from the environment, or a persisted file next to the database, or creates one. */
export function resolveOperatorToken(dbPath: string): string {
  if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN;
  const file = join(dirname(dbPath), 'operator-token.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = `op_${randomBytes(18).toString('hex')}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export async function startServer(opts: Partial<GameOptions> & { port?: number; host?: string } = {}): Promise<RunningServer> {
  const dbPath = opts.dbPath ?? process.env.DB_PATH ?? 'data/world.db';
  const operatorToken = opts.operatorToken ?? resolveOperatorToken(dbPath);
  if (operatorToken.startsWith('bot_')) throw new Error('operator token must not look like a bot token');
  const game = new Game({ ...opts, dbPath, operatorToken, speed: opts.speed ?? Number(process.env.WORLD_SPEED ?? '1') });
  game.start();
  const http = createHttpServer(game);
  const port = opts.port ?? Number(process.env.PORT ?? '7777');
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  const addr = http.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;
  const prune = setInterval(() => game.pruneCommands(), 3600_000);
  return {
    game, http, url, operatorToken,
    stop: async () => {
      clearInterval(prune);
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      game.close();
    },
  };
}

if (import.meta.main) {
  const s = await startServer();
  console.log(`noibla world running at ${s.url}  (speed ×${s.game.speed})`);
  console.log(`dashboard: ${s.url}/dashboard`);
  console.log(`operator token: ${process.env.OPERATOR_TOKEN ? '(from OPERATOR_TOKEN)' : `stored in ${join(dirname(process.env.DB_PATH ?? 'data/world.db'), 'operator-token.txt')}`}`);
  const shutdown = async () => { await s.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
