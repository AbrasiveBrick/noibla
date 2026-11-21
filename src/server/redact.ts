// Redaction rules for anything the operator can see (dashboard, debug view,
// feedback context, server logs).
//  - Players only ever see their own private conversations. The operator dashboard shows them
//    in full, but feedback reports still scrub them.
//  - Nothing may reveal a pending trade submission or lock.

/** Commands whose failures could reveal a pending submission or lock state. */
const SECRET_TRADE_COMMANDS = new Set(['trade.submit', 'trade.lock']);

export function redactFailure(type: string, code: string, reason: string): { code: string; reason: string } {
  if (SECRET_TRADE_COMMANDS.has(type)) return { code: 'TRADE_REJECTED', reason: 'redacted: details could reveal a pending trade submission or lock' };
  if (type === 'dm.send' || type.startsWith('dm.')) return { code, reason: reason.slice(0, 200) };
  return { code, reason: reason.slice(0, 300) };
}

/**
 * Removes verbatim private-message text from free-form operator-visible text
 * (feedback reports). `secrets` are DM texts the reporter sent or received.
 */
export function scrubText(text: string, secrets: string[], pendingTradeIds: string[]): string {
  let out = text;
  const sorted = [...new Set(secrets)].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
  for (const s of sorted) out = out.split(s).join('[redacted private message]');
  // Long fragments of private messages (e.g. partial quotes) are also removed.
  for (const s of sorted) {
    for (const frag of fragments(s, 24)) {
      if (out.includes(frag)) out = out.split(frag).join('[redacted]');
    }
  }
  for (const id of pendingTradeIds) out = out.split(id).join('[pending trade]');
  return out;
}

function fragments(s: string, size: number): string[] {
  if (s.length <= size) return [];
  const out: string[] = [];
  for (let i = 0; i + size <= s.length; i += 8) out.push(s.slice(i, i + size));
  return out;
}
