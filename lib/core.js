'use strict';

// Shared logic for the Discord notify MCP server (used by the Vercel function and the local stdio wrapper).

const DEFAULT_CHANNEL_ID = '';
// Discord answers 403 {"code":40333,"internal network error"} to requests with a weak User-Agent.
const USER_AGENT = 'DiscordBot (https://github.com/ven-ichi/discord-mcp, 1.0)';
const MAX_CHUNK = 1900; // Discord hard limit is 2000
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOL = {
  name: 'notify',
  description:
    "Send Josh a Discord message (he gets it on his phone). Use it when you need him: you are blocked, " +
    'you need a decision or permission, a long job finished, or he asked to be pinged. ' +
    'Write a short, self-contained message - he may not see the conversation you are in.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Plain text, max ~1900 characters.' },
    },
    required: ['message'],
    additionalProperties: false,
  },
};

const RpcError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(text) {
  const out = [];
  for (let i = 0; i < text.length; i += MAX_CHUNK) out.push(text.slice(i, i + MAX_CHUNK));
  return out;
}

async function send(env, text) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) throw new RpcError(-32603, 'DISCORD_BOT_TOKEN is not set');
  const channelId = env.DISCORD_CHANNEL_ID || DEFAULT_CHANNEL_ID;
  if (!channelId) throw new RpcError(-32603, 'DISCORD_CHANNEL_ID is not set');
  const body = String(text ?? '').trim();
  if (!body) throw new RpcError(-32602, 'message is empty');

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const ids = [];
  for (const part of chunk(body)) {
    // shortcut: one retry on 429 only; an AI spamming harder than that fails loudly instead of looping.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: part }),
      });
      if (res.status === 429 && attempt < 1) {
        const info = await res.json().catch(() => ({}));
        await sleep(Math.min(Number(info.retry_after) || 1, 10) * 1000 + 250);
        continue;
      }
      if (!res.ok) {
        throw new RpcError(-32603, `Discord ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      ids.push((await res.json()).id);
      break;
    }
  }
  return { channelId, messageIds: ids };
}

// Returns a JSON-RPC result object, or null when the message is a notification (no reply).
async function dispatch(env, msg) {
  const method = msg && msg.method;
  if (!method) return null;
  if (method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    const asked = msg.params && msg.params.protocolVersion;
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'discord', version: '1.0.0' },
      instructions: 'notify(message) pings Josh on Discord. Use sparingly, for things that actually need him.',
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: [TOOL] };
  if (method === 'tools/call') {
    const params = msg.params || {};
    if (params.name !== TOOL.name) throw new RpcError(-32602, `Unknown tool: ${params.name}`);
    const args = params.arguments || {};
    if (typeof args.message !== 'string') throw new RpcError(-32602, 'message must be a string');
    const sent = await send(env, args.message);
    return {
      content: [{ type: 'text', text: `Sent to Discord #bots (${sent.messageIds.join(', ')})` }],
      isError: false,
    };
  }
  throw new RpcError(-32601, `Method not found: ${method}`);
}

async function respond(env, msg) {
  try {
    const result = await dispatch(env, msg);
    if (result === null) return null;
    return { jsonrpc: '2.0', id: msg.id ?? null, result };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: '2.0', id: msg.id ?? null, error: { code, message: err.message } };
  }
}

module.exports = { TOOL, dispatch, respond, send, chunk, DEFAULT_CHANNEL_ID };

// Offline self-check: node lib/core.js  (no network, no token needed)
if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(chunk('a'.repeat(4500)).length, 3);
  assert.strictEqual(chunk('short').length, 1);
  (async () => {
    const init = await respond({}, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    const list = await respond({}, { id: 2, method: 'tools/list' });
    assert.strictEqual(list.result.tools[0].name, 'notify');
    const bogus = await respond({}, { id: 3, method: 'nope' });
    assert.strictEqual(bogus.error.code, -32601);
    const noToken = await respond({}, { id: 4, method: 'tools/call', params: { name: 'notify', arguments: { message: 'hi' } } });
    assert.strictEqual(noToken.error.message, 'DISCORD_BOT_TOKEN is not set');
    assert.strictEqual(await respond({}, { method: 'notifications/initialized' }), null);
    console.log('core self-check OK');
  })();
}
