// Stand-in Messages API for sandbox/check/turns.sh (no network, no credentials). TOOL = tool to call at the start of every turn, INPUT = its JSON input.
import http from 'node:http';
const tool = process.env.TOOL, input = JSON.parse(process.env.INPUT || '{}');
let n = 0;
const sse = (res, ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify({ type: ev, ...d })}\n\n`);
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    console.error(req.method, req.url);
    if (req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); return res.end('{"input_tokens":10}'); }
    let j = {}; try { j = JSON.parse(b); } catch {}
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1];
    const hasResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
    const names = (j.tools || []).map((t) => t.name);
    const callTool = tool && names.includes(tool) && !hasResult;
    const content = callTool ? [{ type: 'tool_use', id: 'toolu_' + (++n), name: tool, input }] : [{ type: 'text', text: 'turn done' }];
    const msg = { id: 'msg_' + (++n), type: 'message', role: 'assistant', model: j.model || 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    if (!j.stream) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ...msg, content, stop_reason: callTool ? 'tool_use' : 'end_turn' })); }
    res.setHeader('content-type', 'text/event-stream');
    sse(res, 'message_start', { message: msg });
    const c = content[0];
    sse(res, 'content_block_start', { index: 0, content_block: c.type === 'text' ? { type: 'text', text: '' } : { ...c, input: {} } });
    sse(res, 'content_block_delta', { index: 0, delta: c.type === 'text' ? { type: 'text_delta', text: c.text } : { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    sse(res, 'content_block_stop', { index: 0 });
    sse(res, 'message_delta', { delta: { stop_reason: callTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    sse(res, 'message_stop', {}); res.end();
  });
}).listen(8099, '127.0.0.1');
