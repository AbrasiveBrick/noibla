// SQLite persistence. The game keeps hot state in memory and writes it through
// inside the same transaction that records the command result, so a command's
// effects and its idempotency record commit (or roll back) together.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loot_bags (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uniques (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, trade_id TEXT NOT NULL, counterparty_id TEXT NOT NULL,
  at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_owner ON receipts(owner_id, at);
CREATE TABLE IF NOT EXISTS commands (
  player_id TEXT NOT NULL, command_id TEXT NOT NULL, type TEXT NOT NULL, payload_hash TEXT NOT NULL,
  result TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (player_id, command_id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_channel ON chat_messages(channel, id);
CREATE TABLE IF NOT EXISTS forum_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  tags TEXT NOT NULL, created_at INTEGER NOT NULL, last_post_at INTEGER NOT NULL, reply_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS forum_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS forum_posts_thread ON forum_posts(thread_id, id);
CREATE TABLE IF NOT EXISTS dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  text TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dm_conv ON dm_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS dm_reads (player_id TEXT NOT NULL, conversation_id TEXT NOT NULL, last_read_id INTEGER NOT NULL, PRIMARY KEY (player_id, conversation_id));
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, player_id TEXT NOT NULL, command_id TEXT, type TEXT NOT NULL,
  code TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, player_id TEXT NOT NULL, category TEXT NOT NULL,
  summary TEXT NOT NULL, details TEXT NOT NULL, context TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS economy_ledger (kind TEXT PRIMARY KEY, qty INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, player_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_ts ON snapshots(ts);
CREATE INDEX IF NOT EXISTS failures_player ON failures(player_id, id);
`;

export class Store {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.db.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  run(sql: string, ...params: any[]) { return this.stmt(sql).run(...params); }
  get<T = any>(sql: string, ...params: any[]): T | undefined { return this.stmt(sql).get(...params) as T | undefined; }
  all<T = any>(sql: string, ...params: any[]): T[] { return this.stmt(sql).all(...params) as T[]; }

  /** Runs fn in a transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.depth--;
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value; }
  setMeta(key: string, value: string) { this.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

  /** Adds qty to a cumulative silver ledger counter (observation only; never read by game rules). */
  ledger(kind: string, qty: number) {
    if (qty > 0) this.run('INSERT INTO economy_ledger(kind, qty) VALUES(?, ?) ON CONFLICT(kind) DO UPDATE SET qty = qty + excluded.qty', kind, qty);
  }

  close() { this.db.close(); }
}
