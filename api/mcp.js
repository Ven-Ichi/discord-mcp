'use strict';

// Vercel function: stateless MCP over Streamable HTTP at /api/mcp
const { respond } = require('../lib/core');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST only' } });
  }

  // Static bearer token: the only thing between the open internet and Josh's Discord channel.
  const expected = process.env.MCP_TOKEN;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || given !== expected) {
    return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body) throw new Error('empty body');
  } catch {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of messages) {
    const reply = await respond(process.env, msg);
    if (reply) replies.push(reply);
  }

  // Notifications only: the spec asks for 202 with no body.
  if (replies.length === 0) return res.status(202).end();

  const payload = Array.isArray(body) ? replies : replies[0];

  // Some MCP clients (notably the ChatGPT connector scanner) only accept an SSE frame.
  if (String(req.headers.accept || '').includes('text/event-stream')) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    return res.status(200).send(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  return res.status(200).json(payload);
};
