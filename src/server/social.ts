// Agent communication: zone channels, the town trade forum, private messages,
// and feedback reports. Access is enforced here for history and in
// Game.canSee for live events. Chat never carries system or trade-state messages.

import type { ZoneId } from '../shared/catalog.ts';
import type { ChatMessage, ConversationSummary, DirectMessage, FeedbackCategory, ForumPost, ForumThreadSummary } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import type { CommandDef, Player } from './types.ts';
import { cleanText, fail, optInt, optStr, reqInt, reqStr } from './util.ts';
import { requireZone } from './world.ts';
import { redactFailure, scrubText } from './redact.ts';

const MAX_CHAT = 500;
const MAX_TITLE = 120;
const MAX_BODY = 2000;
const TAG_RE = /^[a-z0-9_-]{1,24}$/;

export function conversationId(a: string, b: string): string {
  return `dm:${[a, b].sort().join(':')}`;
}

function participantsOf(convId: string): [string, string] | null {
  const m = /^dm:(p_[a-f0-9]+):(p_[a-f0-9]+)$/.exec(convId);
  return m ? [m[1], m[2]] : null;
}

function nameOf(g: Game, id: string) { return g.players.get(id)?.name ?? 'unknown'; }

function requireInZone(g: Game, p: Player): ZoneId {
  if (p.travel || !p.zone) fail('TRAVELING', 'zone channels are unavailable while traveling', p.travel ? p.travel.arriveAt - g.now() : undefined);
  return p.zone!;
}

// ---------- zone channels ----------

function chatRow(g: Game, r: { id: number; channel: string; author_id: string; text: string; ts: number }): ChatMessage {
  return { id: r.id, channel: r.channel, authorId: r.author_id, authorName: nameOf(g, r.author_id), text: r.text, ts: r.ts, authorKind: 'player' };
}

function chatSay(g: Game, p: Player, payload: Record<string, any>) {
  const zone = requireInZone(g, p);
  const text = cleanText(payload, 'text', MAX_CHAT);
  const channel = `zone:${zone}`;
  const ts = g.now();
  const res = g.store.run('INSERT INTO chat_messages(channel, author_id, text, ts) VALUES(?, ?, ?, ?)', channel, p.id, text, ts);
  const message = chatRow(g, { id: Number(res.lastInsertRowid), channel, author_id: p.id, text, ts });
  g.emit('chat.message', { kind: 'zone', zone }, { message }, { zone, actor: p });
  g.setLastAction(p, 'chat', `spoke in ${channel}`);
  return { message };
}

function chatHistory(g: Game, p: Player, payload: Record<string, any>) {
  const channel = reqStr(payload, 'channel', 40);
  const limit = optInt(payload, 'limit', 1, 200, 50);
  const beforeId = optInt(payload, 'beforeId', 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (channel.startsWith('dm:')) fail('FORBIDDEN', 'private conversations are read with dm.history, and only by their two participants');
  const m = /^zone:(town|wilds|frontier)$/.exec(channel);
  if (!m) fail('NOT_FOUND', `unknown channel "${channel}"`);
  const zone = requireInZone(g, p);
  if (m![1] !== zone) fail('FORBIDDEN', `you can only read the channel of the zone you are in (zone:${zone})`);
  const rows = g.store.all('SELECT id, channel, author_id, text, ts FROM chat_messages WHERE channel = ? AND id < ? ORDER BY id DESC LIMIT ?', channel, beforeId, limit);
  return { channel, messages: rows.reverse().map((r) => chatRow(g, r)) };
}

// ---------- trade forum (town only) ----------

function threadRow(g: Game, r: any): ForumThreadSummary {
  return { id: r.id, authorId: r.author_id, authorName: nameOf(g, r.author_id), title: r.title, tags: JSON.parse(r.tags), createdAt: r.created_at, lastPostAt: r.last_post_at, replyCount: r.reply_count };
}

function postRow(g: Game, r: any): ForumPost {
  return { id: r.id, threadId: r.thread_id, authorId: r.author_id, authorName: nameOf(g, r.author_id), body: r.body, ts: r.ts, authorKind: 'player' };
}

function createThread(g: Game, p: Player, payload: Record<string, any>) {
  requireZone(g, p, 'town', 'the trade forum');
  const title = cleanText(payload, 'title', MAX_TITLE);
  const body = cleanText(payload, 'body', MAX_BODY);
  const tags = payload.tags === undefined ? [] : payload.tags;
  if (!Array.isArray(tags) || tags.length > 5 || !tags.every((t) => typeof t === 'string' && TAG_RE.test(t))) fail('BAD_REQUEST', 'tags must be up to 5 strings matching [a-z0-9_-]{1,24}');
  const ts = g.now();
  const res = g.store.run('INSERT INTO forum_threads(author_id, title, body, tags, created_at, last_post_at) VALUES(?, ?, ?, ?, ?, ?)', p.id, title, body, JSON.stringify(tags), ts, ts);
  const thread = threadRow(g, g.store.get('SELECT * FROM forum_threads WHERE id = ?', Number(res.lastInsertRowid)));
  g.emit('forum.thread', { kind: 'forum' }, { thread, body }, { zone: 'town', actor: p });
  g.setLastAction(p, 'forum', `posted trade thread "${title}"`);
  return { thread };
}

function reply(g: Game, p: Player, payload: Record<string, any>) {
  requireZone(g, p, 'town', 'the trade forum');
  const threadId = reqInt(payload, 'threadId', 1, Number.MAX_SAFE_INTEGER);
  const body = cleanText(payload, 'body', MAX_BODY);
  const t = g.store.get<any>('SELECT * FROM forum_threads WHERE id = ?', threadId);
  if (!t) fail('NOT_FOUND', `no thread ${threadId}`);
  const ts = g.now();
  const res = g.store.run('INSERT INTO forum_posts(thread_id, author_id, body, ts) VALUES(?, ?, ?, ?)', threadId, p.id, body, ts);
  g.store.run('UPDATE forum_threads SET last_post_at = ?, reply_count = reply_count + 1 WHERE id = ?', ts, threadId);
  const post = postRow(g, { id: Number(res.lastInsertRowid), thread_id: threadId, author_id: p.id, body, ts });
  g.emit('forum.reply', { kind: 'forum' }, { post, threadTitle: t.title }, { zone: 'town', actor: p });
  g.setLastAction(p, 'forum', `replied to "${t.title}"`);
  return { post };
}

function listThreads(g: Game, p: Player, payload: Record<string, any>) {
  requireZone(g, p, 'town', 'the trade forum');
  const limit = optInt(payload, 'limit', 1, 100, 30);
  const tag = optStr(payload, 'tag', 24);
  const authorId = optStr(payload, 'authorId', 40);
  let rows = g.store.all('SELECT * FROM forum_threads ORDER BY last_post_at DESC, id DESC LIMIT 500');
  if (tag) rows = rows.filter((r) => (JSON.parse(r.tags) as string[]).includes(tag));
  if (authorId) rows = rows.filter((r) => r.author_id === authorId);
  return { threads: rows.slice(0, limit).map((r) => threadRow(g, r)) };
}

function getThread(g: Game, p: Player, payload: Record<string, any>) {
  requireZone(g, p, 'town', 'the trade forum');
  const threadId = reqInt(payload, 'threadId', 1, Number.MAX_SAFE_INTEGER);
  const t = g.store.get<any>('SELECT * FROM forum_threads WHERE id = ?', threadId);
  if (!t) fail('NOT_FOUND', `no thread ${threadId}`);
  const replies = g.store.all('SELECT * FROM forum_posts WHERE thread_id = ? ORDER BY id ASC LIMIT 500', threadId).map((r) => postRow(g, r));
  return { thread: { ...threadRow(g, t), body: t.body, replies } };
}

// ---------- private messages ----------

function dmRow(g: Game, r: any): DirectMessage {
  return { id: r.id, conversationId: r.conversation_id, fromId: r.from_id, fromName: nameOf(g, r.from_id), toId: r.to_id, text: r.text, ts: r.ts, authorKind: 'player' };
}

function markRead(g: Game, playerId: string, convId: string, upToId: number) {
  g.store.run(
    `INSERT INTO dm_reads(player_id, conversation_id, last_read_id) VALUES(?, ?, ?)
     ON CONFLICT(player_id, conversation_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    playerId, convId, upToId);
}

function dmSend(g: Game, p: Player, payload: Record<string, any>) {
  const to = reqStr(payload, 'to', 40);
  const text = cleanText(payload, 'text', MAX_CHAT);
  const target = g.players.get(to);
  if (!target) fail('NOT_FOUND', `no player ${to}; use player.lookup to resolve names to stable ids`);
  if (to === p.id) fail('BAD_REQUEST', 'cannot message yourself');
  const convId = conversationId(p.id, to);
  const ts = g.now();
  const res = g.store.run('INSERT INTO dm_messages(conversation_id, from_id, to_id, text, ts) VALUES(?, ?, ?, ?, ?)', convId, p.id, to, text, ts);
  const message = dmRow(g, { id: Number(res.lastInsertRowid), conversation_id: convId, from_id: p.id, to_id: to, text, ts });
  markRead(g, p.id, convId, message.id);
  g.emit('dm.message', { kind: 'dm', a: p.id, b: to }, { message }, {});
  // The operator dashboard shows private conversations in full. Other players never see them.
  g.emit('dm.sent', { kind: 'operator' }, { playerId: p.id, name: p.name, toId: to, toName: target!.name, conversationId: convId, messageId: message.id, text }, { actor: p });
  g.setLastAction(p, 'dm', 'sent a private message');
  return { message };
}

function resolveConversation(p: Player, payload: Record<string, any>): string {
  const convId = optStr(payload, 'conversationId', 80);
  const withId = optStr(payload, 'with', 40);
  if (convId) {
    const parts = participantsOf(convId);
    if (!parts) fail('NOT_FOUND', `unknown conversation ${convId}`);
    if (!parts!.includes(p.id)) fail('FORBIDDEN', 'only the two participants can read a private conversation');
    return convId!;
  }
  if (!withId) fail('BAD_REQUEST', 'provide `with` (player id) or `conversationId`');
  return conversationId(p.id, withId!);
}

function dmHistory(g: Game, p: Player, payload: Record<string, any>) {
  const convId = resolveConversation(p, payload);
  const limit = optInt(payload, 'limit', 1, 200, 50);
  const beforeId = optInt(payload, 'beforeId', 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const afterId = optInt(payload, 'afterId', 0, Number.MAX_SAFE_INTEGER, 0);
  const rows = afterId > 0
    ? g.store.all('SELECT * FROM dm_messages WHERE conversation_id = ? AND id > ? AND id < ? ORDER BY id ASC LIMIT ?', convId, afterId, beforeId, limit)
    : g.store.all('SELECT * FROM dm_messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?', convId, beforeId, limit).reverse();
  // Defense in depth: every row must involve the caller.
  const messages = rows.filter((r) => r.from_id === p.id || r.to_id === p.id).map((r) => dmRow(g, r));
  return { conversationId: convId, messages };
}

function dmConversations(g: Game, p: Player) {
  const rows = g.store.all<any>(
    `SELECT conversation_id, MAX(id) AS last_id, MAX(ts) AS last_ts,
            SUM(CASE WHEN to_id = ? AND id > COALESCE((SELECT last_read_id FROM dm_reads r WHERE r.player_id = ? AND r.conversation_id = m.conversation_id), 0) THEN 1 ELSE 0 END) AS unread
     FROM dm_messages m WHERE from_id = ? OR to_id = ? GROUP BY conversation_id ORDER BY last_id DESC`, p.id, p.id, p.id, p.id);
  const conversations: ConversationSummary[] = rows.map((r) => {
    const parts = participantsOf(r.conversation_id)!;
    const other = parts[0] === p.id ? parts[1] : parts[0];
    return { conversationId: r.conversation_id, withId: other, withName: nameOf(g, other), lastMessageId: r.last_id, lastTs: r.last_ts, unread: r.unread };
  });
  return { conversations };
}

function dmMarkRead(g: Game, p: Player, payload: Record<string, any>) {
  const convId = reqStr(payload, 'conversationId', 80);
  const upToId = reqInt(payload, 'upToId', 0, Number.MAX_SAFE_INTEGER);
  const parts = participantsOf(convId);
  if (!parts || !parts.includes(p.id)) fail('FORBIDDEN', 'not your conversation');
  markRead(g, p.id, convId, upToId);
  const unread = g.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ? AND to_id = ? AND id > ?', convId, p.id, upToId)?.n ?? 0;
  return { unread };
}

// ---------- feedback ----------

const CATEGORIES: FeedbackCategory[] = ['bug', 'confusing_api', 'missing_feature', 'other'];

function reportFeedback(g: Game, p: Player, payload: Record<string, any>) {
  const category = reqStr(payload, 'category', 30) as FeedbackCategory;
  if (!CATEGORIES.includes(category)) fail('BAD_REQUEST', `category must be one of ${CATEGORIES.join(', ')}`);
  const summary = cleanText(payload, 'summary', 200);
  const details = payload.details === undefined ? '' : cleanText(payload, 'details', 4000);
  const relatedCommandId = optStr(payload, 'relatedCommandId', 128);
  // Never let private message contents or pending trade ids into operator-visible reports.
  const secrets = g.store.all<{ text: string }>('SELECT text FROM dm_messages WHERE from_id = ? OR to_id = ? ORDER BY id DESC LIMIT 1000', p.id, p.id).map((r) => r.text);
  const pending = [...g.trades.values()].filter((t) => (t.status === 'proposed' || t.status === 'agreed') && (t.proposerId === p.id || t.counterpartyId === p.id)).map((t) => t.id);
  const safeSummary = scrubText(summary, secrets, pending);
  const safeDetails = scrubText(details, secrets, pending);
  const recent = (g.recentCommands.get(p.id) ?? []).slice(-10).map((c) => ({ ...c, code: c.code ? redactFailure(c.type, c.code, '').code : undefined }));
  const context = { zone: p.zone, traveling: !!p.travel, hp: p.hp, relatedCommandId: relatedCommandId ?? null, recentCommands: recent };
  const res = g.store.run('INSERT INTO feedback(ts, player_id, category, summary, details, context) VALUES(?, ?, ?, ?, ?, ?)', g.now(), p.id, category, safeSummary, safeDetails, JSON.stringify(context));
  const feedbackId = Number(res.lastInsertRowid);
  g.emit('feedback', { kind: 'operator' }, { feedbackId, playerId: p.id, name: p.name, category, summary: safeSummary }, { actor: p });
  return { feedbackId };
}

const ro = (run: CommandDef['run']): CommandDef => ({ mutates: false, run });
const rw = (run: CommandDef['run']): CommandDef => ({ mutates: true, run });

export const socialCommands: Record<string, CommandDef> = {
  'chat.say': rw(chatSay),
  'chat.history': ro(chatHistory),
  'forum.createThread': rw(createThread),
  'forum.reply': rw(reply),
  'forum.listThreads': ro(listThreads),
  'forum.getThread': ro(getThread),
  'dm.send': rw(dmSend),
  'dm.history': ro(dmHistory),
  'dm.conversations': ro((g, p) => dmConversations(g, p)),
  'dm.markRead': rw(dmMarkRead),
  reportFeedback: rw(reportFeedback),
};
