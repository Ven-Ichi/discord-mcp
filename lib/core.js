'use strict';

// Shared logic for the Discord MCP server (used by Cloudflare Workers, Vercel, and local stdio).

// Discord answers 403 {"code":40333,"internal network error"} to requests with a weak User-Agent.
const USER_AGENT = 'DiscordBot (https://github.com/ven-ichi/discord-mcp, 1.0)';
const API = 'https://discord.com/api/v10';
const MAX_CHUNK = 1900; // Discord hard limit is 2000
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Tap-to-answer reactions; index order is the option order.
const OPTION_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

const TOOLS = [
  {
    name: 'notify',
    description:
      'Send the user a Discord message. Use it when you need them: you are blocked, ' +
      'you need a decision or permission, a long job finished, or they asked to be pinged. ' +
      'Write a short, self-contained message - they may not see the conversation you are in. ' +
      'Pass options to offer up to 5 choices as numbered reactions they can tap, then call check_replies or wait_for_reply.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Plain text, max ~1900 characters.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 5,
          description: 'Up to 5 short choices. Each becomes a numbered emoji reaction the user can tap instead of typing.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_replies',
    description:
      'Read what the user wrote or reacted in the Discord channel. Call it after notify when you are waiting for an ' +
      'answer, and poll again if they have not replied yet. Returns their messages (newest last), which message of yours ' +
      'each one replies to, and any reactions they tapped on your recent messages.',
    inputSchema: {
      type: 'object',
      properties: {
        after_id: {
          type: 'string',
          description: 'Optional message id. Only return messages newer than it. Defaults to your own latest message.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_reply',
    description:
      'Block until the user answers your latest Discord message - tap on one of the options you sent, or a typed reply - ' +
      'then return their answer. Waits up to 210 seconds by default; if it returns "No answer", just call it again. ' +
      'This is the blocking version of check_replies and is usually what you want after notify with options.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: {
          type: 'integer',
          minimum: 1,
          maximum: 210,
          description: 'How long to wait for an answer, in seconds. Default: the maximum (210).',
        },
        after_id: {
          type: 'string',
          description: 'Optional message id; only answers newer than it count. Defaults to your latest message.',
        },
      },
      additionalProperties: false,
    },
  },
];

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

function requireEnv(env) {
  if (!env.DISCORD_BOT_TOKEN) throw new RpcError(-32603, 'DISCORD_BOT_TOKEN is not set');
  if (!env.DISCORD_CHANNEL_ID) throw new RpcError(-32603, 'DISCORD_CHANNEL_ID is not set');
  return { token: env.DISCORD_BOT_TOKEN, channelId: env.DISCORD_CHANNEL_ID };
}

async function api(env, path, init = {}) {
  const { token } = requireEnv(env);
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT, ...(init.headers || {}) },
  });
  // shortcut: one retry on 429 only; a caller hammering harder fails loudly instead of looping.
  if (res.status === 429) {
    const info = await res.json().catch(() => ({}));
    await sleep(Math.min(Number(info.retry_after) || 1, 10) * 1000 + 250);
    return api(env, path, init);
  }
  if (!res.ok) throw new RpcError(-32603, `Discord ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

// Cached per isolate: the identity never changes, and Cloudflare Free caps subrequests per request.
let botUser;
async function bot(env) {
  if (!botUser) botUser = await api(env, '/users/@me');
  return botUser;
}

function buildBody(env, text, options) {
  const mention = env.DISCORD_MENTION_USER_ID ? `<@${env.DISCORD_MENTION_USER_ID}> ` : '';
  const lines = options && options.length
    ? `\n\n${options.map((o, i) => `${OPTION_EMOJI[i]} ${o}`).join('\n')}\n\nReact with a number to answer.`
    : '';
  return mention + text + lines;
}

async function send(env, text, options) {
  const { channelId } = requireEnv(env);
  const clean = String(text ?? '').trim();
  if (!clean) throw new RpcError(-32602, 'message is empty');
  if (options && (!Array.isArray(options) || options.length > OPTION_EMOJI.length)) {
    throw new RpcError(-32602, `options must be an array of at most ${OPTION_EMOJI.length} strings`);
  }

  const ids = [];
  for (const part of chunk(buildBody(env, clean, options))) {
    const msg = await api(env, `/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: part }),
    });
    ids.push(msg.id);
  }

  // Option reactions go on the last chunk so they sit next to the choices.
  const target = ids[ids.length - 1];
  for (let i = 0; options && i < options.length; i++) {
    await api(env, `/channels/${channelId}/messages/${target}/reactions/${encodeURIComponent(OPTION_EMOJI[i])}/@me`, {
      method: 'PUT',
    });
  }
  return { channelId, messageIds: ids, optionEmoji: options ? OPTION_EMOJI.slice(0, options.length) : [] };
}

function short(text, max = 80) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

async function checkReplies(env, args = {}) {
  const { channelId } = requireEnv(env);
  const me = await bot(env);
  const messages = await api(env, `/channels/${channelId}/messages?limit=50`);
  const newestFirst = messages; // Discord returns newest first
  const mine = newestFirst.filter((m) => m.author.id === me.id);

  const asked = String(args.after_id || '').trim();
  const floor = /^\d+$/.test(asked) ? BigInt(asked) : mine.length ? BigInt(mine[0].id) : 0n;

  const fromUser = newestFirst
    .filter((m) => m.author.id !== me.id && BigInt(m.id) > floor)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  const lines = [];
  for (const m of fromUser) {
    const reply = m.referenced_message ? ` (replying to your ${m.referenced_message.id}: "${short(m.referenced_message.content, 50)}")` : '';
    const text = m.content ? `"${m.content}"` : '(attachment or embed only)';
    const reacts = (m.reactions || []).map((r) => `${r.emoji.name}x${r.count}`).join(' ');
    lines.push(`- ${m.id} ${m.author.username}: ${text}${reply}${reacts ? ` [reactions: ${reacts}]` : ''}`);
  }

  // Who reacted on your recent messages (the bot's own option reactions are filtered out).
  const reactionLines = [];
  for (const m of mine.slice(0, 3)) {
    for (const r of m.reactions || []) {
      if (r.me && r.count === 1) continue; // only the bot's own tap
      const users = await api(env, `/channels/${channelId}/messages/${m.id}/reactions/${encodeURIComponent(r.emoji.name)}?limit=100`);
      const humans = users.filter((u) => !u.bot);
      if (humans.length) {
        reactionLines.push(`- your ${m.id} "${short(m.content, 50)}" got ${r.emoji.name} from ${humans.map((u) => u.username).join(', ')}`);
      }
    }
  }

  if (!lines.length && !reactionLines.length) {
    return { text: 'No new messages or reactions.', hasReplies: false };
  }
  const parts = [];
  if (lines.length) parts.push(`${lines.length} message(s):`, ...lines);
  if (reactionLines.length) parts.push('', 'Reactions on your messages:', ...reactionLines);
  return { text: parts.join('\n'), hasReplies: true };
}

function optionLabel(content, index) {
  const line = String(content || '')
    .split('\n')
    .find((l) => l.startsWith(OPTION_EMOJI[index]));
  return line ? line.slice(OPTION_EMOJI[index].length).trim() : `option ${index + 1}`;
}

// One poll of the channel: the user's newest message, or their reaction on your newest message.
async function pollAnswer(env, afterId) {
  const { channelId } = requireEnv(env);
  const me = await bot(env);
  const messages = await api(env, `/channels/${channelId}/messages?limit=20`);
  const newestMine = messages.find((m) => m.author.id === me.id);
  const floor = /^\d+$/.test(String(afterId || ''))
    ? BigInt(String(afterId))
    : newestMine
      ? BigInt(newestMine.id)
      : 0n;

  const human = messages.filter((m) => m.author.id !== me.id && BigInt(m.id) > floor);
  if (human.length) {
    const m = human[0]; // newest first
    return {
      answered: true,
      kind: 'text',
      answer: m.content || '(attachment or embed only)',
      by: m.author.username,
      ref: m.id,
      replyingTo: m.referenced_message ? m.referenced_message.id : null,
    };
  }

  for (const r of (newestMine && newestMine.reactions) || []) {
    // Skip only the bot's own tap; a lone human reaction still counts.
    if (r.me && r.count === 1) continue;
    const users = await api(
      env,
      `/channels/${channelId}/messages/${newestMine.id}/reactions/${encodeURIComponent(r.emoji.name)}?limit=100`,
    );
    const who = users.filter((u) => !u.bot);
    if (!who.length) continue;
    const idx = OPTION_EMOJI.indexOf(r.emoji.name);
    return {
      answered: true,
      kind: idx >= 0 ? 'option' : 'reaction',
      answer: idx >= 0 ? optionLabel(newestMine.content, idx) : r.emoji.name,
      option: idx >= 0 ? idx + 1 : null,
      by: who.map((u) => u.username).join(', '),
      ref: newestMine.id,
      replyingTo: null,
    };
  }
  return null;
}

// Cloudflare Free allows 50 subrequests per request and a poll costs about one, so the wait is
// bounded by polls rather than by time: 2s polls for the first 30s, then 6s (~45 polls for 210s).
// shortcut: WAIT_MAX_SECONDS above ~210 can hit that ceiling, raise it only on a paid plan.
const waitMax = (env) => Math.max(1, Number(env.WAIT_MAX_SECONDS) || 210);

async function waitForReply(env, args = {}) {
  const max = waitMax(env);
  const seconds = Math.min(Math.max(Number(args.seconds) || max, 1), max);
  const start = Date.now();
  const deadline = start + seconds * 1000;
  for (;;) {
    const found = await pollAnswer(env, args.after_id);
    if (found) {
      const what = found.kind === 'option' ? `option ${found.option} "${found.answer}"` : `"${found.answer}"`;
      const reply = found.replyingTo ? ` (replying to ${found.replyingTo})` : '';
      return { ...found, text: `Answered by ${found.by}: ${what}${reply} [${found.ref}]` };
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return { answered: false, text: `No answer within ${seconds}s. Call wait_for_reply again to keep waiting.` };
    }
    await sleep(Math.min(Date.now() - start < 30000 ? 2000 : 6000, left));
  }
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
      serverInfo: { name: 'discord', version: '1.1.0' },
      instructions:
        'notify(message, options?) pings the user on Discord; wait_for_reply() blocks until they answer. ' +
        'When you need a decision, send options and then wait_for_reply - they can tap a number, reply, or type free text.',
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const params = msg.params || {};
    const args = params.arguments || {};
    if (params.name === 'notify') {
      if (typeof args.message !== 'string') throw new RpcError(-32602, 'message must be a string');
      const sent = await send(env, args.message, args.options);
      const extra = sent.optionEmoji.length ? ` with options ${sent.optionEmoji.join(' ')}` : '';
      return {
        content: [{ type: 'text', text: `Sent to Discord${extra} (${sent.messageIds.join(', ')})` }],
        isError: false,
      };
    }
    if (params.name === 'check_replies') {
      const res = await checkReplies(env, args);
      return { content: [{ type: 'text', text: res.text }], isError: false };
    }
    if (params.name === 'wait_for_reply') {
      const res = await waitForReply(env, args);
      return { content: [{ type: 'text', text: res.text }], isError: false };
    }
    throw new RpcError(-32602, `Unknown tool: ${params.name}`);
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

module.exports = { TOOLS, dispatch, respond, send, checkReplies, chunk, buildBody, optionLabel, OPTION_EMOJI };
