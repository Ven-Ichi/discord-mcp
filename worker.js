// Cloudflare Worker: stateless MCP over Streamable HTTP at the worker root.
// Same lib/core.js as the Vercel function and the stdio wrapper.
import core from './lib/core.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') {
      return json(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST only' } });
    }

    // Static bearer token: the only thing between the open internet and Josh's Discord channel.
    const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!env.MCP_TOKEN || given !== env.MCP_TOKEN) {
      return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    }

    let body;
    try {
      body = JSON.parse(await request.text());
      if (!body) throw new Error('empty body');
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    const messages = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const msg of messages) {
      const reply = await core.respond(env, msg);
      if (reply) replies.push(reply);
    }

    // Notifications only: the spec asks for 202 with no body.
    if (replies.length === 0) return new Response(null, { status: 202, headers: CORS });

    const payload = Array.isArray(body) ? replies : replies[0];

    // Some MCP clients only accept an SSE frame.
    if ((request.headers.get('accept') || '').includes('text/event-stream')) {
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' },
      });
    }

    return json(200, payload);
  },
};
