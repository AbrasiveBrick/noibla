import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameClient } from '../src/sdk/index.ts';
import { startServer, type RunningServer } from '../src/server/main.ts';

export const OP = 'op_test_operator_token';

export interface World {
  server: RunningServer;
  url: string;
  dir: string;
  bot(name: string, opts?: { connect?: boolean }): Promise<GameClient & { botToken: string }>;
  operator(since?: number): Promise<any>;
  close(opts?: { keepDir?: boolean }): Promise<void>;
}

let counter = 0;

export async function world(o: { speed?: number; dir?: string } = {}): Promise<World> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'noibla-test-'));
  const server = await startServer({ dbPath: join(dir, 'world.db'), port: 0, speed: o.speed ?? 50, operatorToken: OP, log: () => {} });
  const clients: GameClient[] = [];
  return {
    server, url: server.url, dir,
    async bot(name, opts = {}) {
      const reg = await GameClient.register(server.url, `${name}${++counter}`);
      const c = new GameClient({ url: server.url, token: reg.token, recordEvents: true }) as GameClient & { botToken: string };
      c.botToken = reg.token;
      clients.push(c);
      if (opts.connect !== false) await c.connect();
      return c;
    },
    async operator(since = 0) {
      const res = await fetch(`${server.url}/operator/state?since=${since}`, { headers: { authorization: `Bearer ${OP}` } });
      return res.json();
    },
    async close(opts = {}) {
      for (const c of clients) await c.disconnect();
      await server.stop();
      if (!opts.keepDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Connect a client to an existing server with an existing token. */
export function attach(url: string, token: string) {
  return new GameClient({ url, token, recordEvents: true });
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
