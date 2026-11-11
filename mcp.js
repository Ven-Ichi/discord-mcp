'use strict';

// Local MCP over stdio - offline fallback when Vercel is unreachable.
// Reuses the bot token from ../blackboard-discord-bot/.env so no secret is copied around.
const fs = require('fs');
const path = require('path');
const { respond } = require('./lib/core');

function loadEnv() {
  const candidates = [
    process.env.DISCORD_ENV_PATH,
    path.join(__dirname, '..', 'blackboard-discord-bot', '.env'),
    path.join(__dirname, '.env'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return;
  }
}

loadEnv();

// stdout carries protocol frames only; any logging must go to stderr.
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(line);
  }
});

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    return;
  }
  const reply = await respond(process.env, msg);
  if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
}

// No exit hook on stdin end: a tools/call may still be in flight, and the
// event loop already ends the process once it drains.
