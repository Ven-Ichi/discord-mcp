# discord-mcp

A small MCP server that lets an AI agent talk to me on Discord: `notify`, and then wait for my answer.

Works three ways from the same code:

| Transport | Entry point | Used by |
|---|---|---|
| Streamable HTTP (stateless) | `worker.js` on Cloudflare Workers | ChatGPT, remote clients (primary) |
| Streamable HTTP (stateless) | `api/mcp.js` on Vercel | backup endpoint |
| stdio | `mcp.js` | OpenCode, Antigravity, anything local |

No dependencies. Node's built-in `fetch` does the Discord call.

## Tools

`notify({ message, options? })` → posts to one Discord channel, returns the message id.
If `DISCORD_MENTION_USER_ID` is set, the message starts with `<@id>`, so it lands as a ping.
`options` (max 5) appends a numbered list and adds 1️⃣–5️⃣ reactions, so a tap is a valid answer.
Long text is split at 1900 characters (Discord's limit is 2000), with one retry on a 429.

`check_replies({ after_id? })` → reads the channel back. Returns Josh's messages (newest last), which of your
messages each one replies to, and any reactions he tapped on your last three messages. Without `after_id` it
returns everything newer than your own latest message, so the usual flow is: `notify` → wait → `check_replies`.
The bot's own option reactions are filtered out of the report.

## Environment

| Var | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from the Discord developer portal |
| `DISCORD_CHANNEL_ID` | Target channel |
| `DISCORD_MENTION_USER_ID` | Optional. When set, every message is prefixed with `<@id>` so it pings instead of just posting |
| `MCP_TOKEN` | Shared secret; HTTP requests need `Authorization: Bearer <MCP_TOKEN>` |

Locally, `mcp.js` loads these from `../blackboard-discord-bot/.env` if they are not already in the
environment (override the path with `DISCORD_ENV_PATH`). Nothing is hardcoded in this repo.

## Deploy

### Cloudflare Workers (primary)

Free plan, no card, no cold starts, and an HTTP request may run for as long as the client stays
connected — which is what `wait_for_reply` needs.

```bash
wrangler login
wrangler deploy
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_CHANNEL_ID
wrangler secret put DISCORD_MENTION_USER_ID
wrangler secret put MCP_TOKEN
```

The endpoint is the worker root: `https://discord-mcp.<subdomain>.workers.dev`.

Free-plan headroom that matters here: 100k requests/day, 10 ms CPU per request (sleeping costs
none), and 50 subrequests per request. `wait_for_reply(25s)` spends 13 polls × 2 calls, so the bot
identity is cached per isolate and reaction lookups are skipped while `count` is 1.

### Vercel (backup)

```bash
vercel link --yes --project discord-mcp
vercel env add DISCORD_BOT_TOKEN production   # paste, or pipe from your own .env
vercel env add DISCORD_CHANNEL_ID production
vercel env add MCP_TOKEN production
vercel deploy --prod --yes
```

Turn off Vercel Authentication for the project, otherwise every call gets
`401 Protected deployment` before it reaches the function:

```bash
vercel project protection disable --sso
```

Vercel caps a function at 60s, which is why `wait_for_reply` tops out at 25s.

## Client config

OpenCode (`~/.config/opencode/opencode.jsonc`):

```jsonc
"mcp": {
  "discord": {
    "type": "remote",
    "url": "https://discord-mcp.venichi.workers.dev",
    "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
  }
}
```

Antigravity (`~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "discord": {
      "serverUrl": "https://discord-mcp.venichi.workers.dev",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Local stdio instead of HTTP:

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["C:\\path\\to\\discord-mcp\\mcp.js"]
    }
  }
}
```

ChatGPT: Plugins → Add custom MCP server → the `/api/mcp` URL, API-key auth with `MCP_TOKEN`.
Full MCP write actions need a Business/Enterprise plan; a personal plan may refuse it.

## Test

```bash
node selfcheck.js                    # offline self-check, no network
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp.js
```

## Notes

- Discord rejects requests with a weak `User-Agent` using `403 {"code":40333,"internal network error"}`.
  Every request here sets one explicitly — if you fork this and see that error, it is the header, not permissions.
- Anyone holding the URL and `MCP_TOKEN` can post to the channel. There is no per-user auth; the
  token is the whole gate.
