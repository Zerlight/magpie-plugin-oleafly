import http from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

export const models = ['fixture-first', 'fixture-second'];
export const resultText = 'oleafly-fixture-answer';
export const toolMarker = name => 'fixture-result-' + name;
export const referenceFile = 'references/receipt.md';

function mcp({ id, method, params }, name) {
  if (id === undefined) return;
  const result = {
    initialize: () => ({
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name, version: '1.0.0' },
    }),
    ping: () => ({}),
    'tools/list': () => ({
      tools: [{
        name,
        description: 'Return the ' + name + ' acceptance fixture marker.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      }],
    }),
    'tools/call': () => params.name === name
      ? { content: [{ type: 'text', text: toolMarker(name) }] }
      : { isError: true, content: [{ type: 'text', text: 'Unknown fixture tool.' }] },
  }[method];
  return { jsonrpc: '2.0', id, ...(result ? { result: result() } : {
    error: { code: -32601, message: 'Method not found' },
  }) };
}

if (process.argv[2] === 'stdio') {
  for await (const line of createInterface({ input: process.stdin })) {
    const reply = mcp(JSON.parse(line), process.argv[3]);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  }
}

export async function serveFixtures() {
  const upstream = [];
  let plannedCalls = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'CONNECT' || !req.url.startsWith('/')) {
        res.writeHead(403).end();
        return;
      }
      if (req.url === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          object: 'list', data: models.map(id => ({ id, object: 'model' })),
        }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(req.url === '/mcp' ? 405 : 404).end();
        return;
      }
      const body = JSON.parse(await Array.fromAsync(req).then(chunks => Buffer.concat(chunks)));
      if (req.url === '/mcp') {
        const response = mcp(body, 'remoteprobe');
        if (!response) res.writeHead(202).end();
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
        return;
      }
      if (req.url !== '/v1/chat/completions' || !models.includes(body.model)) {
        res.writeHead(400).end();
        return;
      }
      const receipts = (body.messages ?? []).filter(message => message.role === 'tool')
        .map(message => JSON.stringify(message.content));
      const next = plannedCalls[receipts.length];
      const toolName = next?.force ?? (next && body.tools?.find(item => item.function?.name.includes(next.name))?.function?.name);
      const call = toolName && {
        index: 0, id: 'call_fixture_' + receipts.length, type: 'function',
        function: { name: toolName, arguments: JSON.stringify(next.args ?? {}) },
      };
      const message = call ? { tool_calls: [call] } : { content: resultText };
      const finish_reason = call ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const id = 'chatcmpl-fixture-' + (upstream.length + 1);
      upstream.push({
        model: body.model,
        tools: body.tools?.map(item => item.function?.name).filter(Boolean) ?? [],
        // Retain only allowlisted fixture markers, even if a client sends other content.
        receipts: plannedCalls.map(item => item.marker).filter(marker =>
          marker && receipts.some(receipt => receipt.includes(marker))),
      });
      const base = { id, created: 1700000000, model: body.model };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          ...base, object: 'chat.completion', usage,
          choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }],
        }));
        return;
      }
      const chunk = (choices, extra) => 'data: ' + JSON.stringify({
        ...base, object: 'chat.completion.chunk', choices, ...extra,
      }) + '\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(
        chunk([{ index: 0, delta: { role: 'assistant', ...message }, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason }]) +
        chunk([], { usage }) + 'data: [DONE]\n\n',
      );
    } catch {
      res.writeHead(400).end();
    }
  });
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    upstream,
    plan(calls) { plannedCalls = calls; },
    close() { server.close(); server.closeAllConnections(); },
  };
}
