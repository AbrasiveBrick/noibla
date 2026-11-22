// What a sandboxed agent thinks and does, read from the transcript the launcher keeps (sandbox/run-agent.sh).
// Operator only. The content is agent-written: control and bidi characters are stripped, credentials are hidden,
// and the dashboard shows all of it as text.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** Bytes of transcript read per request. */
export const TRANSCRIPT_CHUNK = 1024 * 1024;
const MAX_TEXT = 20_000;
const MAX_OUTPUT = 6_000;
/** The agent names run-agent.sh accepts. Anything else has no transcript, so no name can reach another path. */
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface TranscriptItem {
  /**
   * `thinks`: a thinking summary, or empty when the text was not recorded. `says`: its own words. `does`: a tool call.
   * `sees`: what a tool returned. `turn`: the model started a turn. `error`: the turn failed (a usage limit, say).
   */
  kind: 'thinks' | 'says' | 'does' | 'sees' | 'turn' | 'error';
  ts: number | null;
  text: string;
  /** `does`: the tool, and why the agent says it calls it. */
  tool?: string;
  why?: string;
}

export interface Transcript {
  found: boolean;
  items: TranscriptItem[];
  /** Byte range read. Pass `to` as `after` for what came since, `from` as `before` for what came earlier. */
  from: number;
  to: number;
}

function clean(value: unknown, max = MAX_TEXT): string {
  const text = String(value ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .replace(/sk-ant-[\w-]+/g, '[token hidden]')
    .replace(/\bbot_[\w-]{16,}/g, '[bot token hidden]')
    .trim();
  return text.length > max ? `${text.slice(0, max)}\n[${text.length - max} more characters]` : text;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '';
}

/** The items in one line of `claude --output-format stream-json --verbose`. Other lines (podman, CLI warnings) have none. */
export function transcriptItems(line: string): TranscriptItem[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  if (!j || typeof j !== 'object') return [];
  const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) || null : null;
  if (j.type === 'system' && j.subtype === 'init') return [{ kind: 'turn', ts, text: clean(j.model, 80) }];
  if (j.type === 'result') return j.is_error ? [{ kind: 'error', ts, text: clean(j.result ?? j.subtype) }] : [];
  if (!Array.isArray(j.message?.content)) return [];
  const items: TranscriptItem[] = [];
  for (const b of j.message.content) {
    if (j.type === 'assistant') {
      if (b?.type === 'thinking') items.push({ kind: 'thinks', ts, text: clean(b.thinking) });
      else if (b?.type === 'text') {
        const text = clean(b.text);
        if (text) items.push({ kind: 'says', ts, text });
      } else if (b?.type === 'tool_use') {
        const { description, ...input } = b.input && typeof b.input === 'object' ? b.input : ({} as any);
        items.push({ kind: 'does', ts, tool: clean(b.name, 80), why: clean(description, 500), text: clean(input.command ?? JSON.stringify(input, null, 2)) });
      }
    } else if (j.type === 'user' && b?.type === 'tool_result') {
      const text = clean(resultText(b.content), MAX_OUTPUT);
      if (text) items.push({ kind: 'sees', ts, text });
    }
  }
  return items;
}

/**
 * Part of `<dir>/<name>.log`: what came after byte `after`, or what came before byte `before`, or else the newest part.
 * Only whole lines are returned, so a line still being written comes with the next read.
 */
export function readTranscript(dir: string, name: string, at: { after?: number; before?: number } = {}): Transcript {
  const none: Transcript = { found: false, items: [], from: 0, to: 0 };
  if (!NAME_RE.test(name)) return none;
  let fd: number;
  try {
    fd = openSync(join(dir, `${name}.log`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return none;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return none;
    let from: number;
    let end = st.size;
    let midLine = false;
    if (at.after !== undefined && at.after <= st.size) {
      from = at.after;
      end = Math.min(st.size, from + TRANSCRIPT_CHUNK);
    } else {
      if (at.before !== undefined) end = Math.min(st.size, at.before);
      from = Math.max(0, end - TRANSCRIPT_CHUNK);
      midLine = from > 0;
    }
    const buf = Buffer.alloc(end - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    const last = buf.lastIndexOf(10, n - 1);
    if (!n || last < 0) {
      // A line longer than a chunk is stepped over, else reading would stop there for good.
      const skip = n === TRANSCRIPT_CHUNK;
      return { found: true, items: [], from, to: skip ? from + n : from };
    }
    const start = midLine ? buf.indexOf(10) + 1 : 0;
    const items = start > last ? [] : buf.toString('utf8', start, last).split('\n').flatMap(transcriptItems);
    // With no whole line in the chunk, `from` still moves back.
    return { found: true, items, from: from + (start > last ? 0 : start), to: from + last + 1 };
  } finally {
    closeSync(fd);
  }
}
