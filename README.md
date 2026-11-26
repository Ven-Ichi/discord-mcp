# discord-mcp

A small MCP server that lets an AI agent talk to you on Discord: `notify`, and then wait for your answer.

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
Long text is split at 1900 characters (Discord's limit is 2000). Discord 429 responses are retried.

`check_replies({ after_id? })` → reads the channel back. Returns user messages (newest last), which of your
messages each one replies to, and any reactions tapped on your last three messages. Without `after_id` it
returns everything newer than your own latest message, so the usual flow is: `notify` → wait → `check_replies`.
The bot's own option reactions are filtered out of the report.

`wait_for_reply({ seconds?, after_id? })` → waits for a typed answer or reaction. It waits the full
210 seconds by default (the idler polls every 2 s, then every 6 s to stay inside Cloudflare's
50-subrequest limit); `WAIT_MAX_SECONDS` lowers the cap. Numbered reactions are mapped back to their option labels.
After a timeout, call again to keep waiting. These are polling tools: Discord messages do not wake an
idle AI session or automatically answer an agent's built-in question dialog.

## Environment

| Var | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from the Discord developer portal |
| `DISCORD_CHANNEL_ID` | Target channel |
| `DISCORD_MENTION_USER_ID` | Optional. When set, every message is prefixed with `<@id>` so it pings instead of just posting |
| `MCP_TOKEN` | Shared secret; HTTP requests need `Authorization: Bearer <MCP_TOKEN>` |
| `WAIT_MAX_SECONDS` | Optional. Max `wait_for_reply` window in seconds (default `210`; set `50` on Vercel) |

Locally, `mcp.js` loads these from `.env` in the repository root if they are not already in the
environment (override the path with `DISCORD_ENV_PATH`). Nothing is hardcoded in this repo.

## Deploy

### Cloudflare Workers (primary)

Use Node.js and Wrangler (the commands below run Wrangler through `npx`). The Free plan has no
Render-style idle spin-down. HTTP requests have no hard wall-time limit while the client stays
connected, but CPU limits, subrequest limits, client timeouts, and runtime interruptions still apply.

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_CHANNEL_ID
npx wrangler secret put DISCORD_MENTION_USER_ID
npx wrangler secret put MCP_TOKEN
```

The endpoint is the worker root: `https://discord-mcp.<your-subdomain>.workers.dev` — no `/api/mcp` suffix needed.
If a subdomain is required, choose a free `workers.dev` subdomain in Cloudflare's **Workers & Pages**
account details. You do not need to buy or own a domain.

Free-plan headroom that matters here: 100k requests/day, 10 ms CPU per request (sleeping costs
none), and 50 subrequests per request. The bot identity is cached per isolate, each poll fetches
recent messages, and reaction-user lookups are skipped only when the bot is the sole reactor.
Busy reaction sets or repeated rate-limit retries can still exhaust the subrequest budget.

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

This project's `vercel.json` sets a 60-second function duration, so the Vercel backup cannot hold a
210-second wait — set `WAIT_MAX_SECONDS=50` there. The Worker has no wall-clock limit and is the
host to use for long waits.

## Client config

OpenCode (`~/.config/opencode/opencode.jsonc`):

```jsonc
"mcp": {
  "discord": {
    "type": "remote",
    "url": "https://discord-mcp.<your-subdomain>.workers.dev",
    "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
  }
}
```

Antigravity (`~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "discord": {
      "serverUrl": "https://discord-mcp.<your-subdomain>.workers.dev",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

After changing Antigravity's URL or the server's tool schemas:

1. Open **Customizations → Installed → MCP Servers**.
2. Next to **discord**, choose **⋮ → Restart**.
3. Start a new chat and confirm `notify`, `check_replies`, and `wait_for_reply` are available.

The existing MCP bearer token remains valid across host changes. Do not substitute the
Discord bot token.

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

### ChatGPT (web)

1. Open **Plugins → + → Add custom MCP server**.
2. Name it `discord` and enter `https://discord-mcp.<your-subdomain>.workers.dev` as the connection URL.
3. Configure API-key/bearer authentication with `MCP_TOKEN` so requests send
   `Authorization: Bearer <MCP_TOKEN>`. Use the MCP token, not `DISCORD_BOT_TOKEN`.
   If your interface does not offer this authentication method, stop and check compatibility;
   this server does not implement OAuth.
4. Review the risk warning, select **Create as a plugin**, and verify all three tools are discovered.
5. Install/select the plugin in a new conversation with `@discord`, and approve actions when prompted.

For an existing connection, update its endpoint and refresh its tools; recreate the connection if
its URL cannot be edited. Server tool changes do not automatically update ChatGPT's approved snapshot.

Full MCP support, including Discord sending, currently requires Business or Enterprise/Edu and
appropriate workspace permissions. Pro's custom MCP read/fetch access does not enable sending.
See [OpenAI's current connection and plan requirements](https://help.openai.com/en/articles/12584461).
Antigravity's [MCP documentation](https://antigravity.google/docs/mcp/) covers reconnects and custom headers.

Keep actual tokens out of this README, screenshots, and Git.

## Test

```bash
node selfcheck.js                    # offline self-check, no network
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp.js
```

In each connected client, try:

> Send me a Discord question with two options, then wait for my reaction or typed reply.

Confirm the ping arrives, tap an option or reply, and check that the client reports your answer.
If the wait expires, ask the client to call `wait_for_reply` again — it waits 210 seconds per call.

## Notes

- Discord rejects requests with a weak `User-Agent` using `403 {"code":40333,"internal network error"}`.
  Every request here sets one explicitly — if you fork this and see that error, it is the header, not permissions.
- Anyone holding the URL and `MCP_TOKEN` can post to the channel. There is no per-user auth; the
  token is the whole gate.
- Antigravity reads `mcp_config.json` once at startup. After editing it, quit every Antigravity
  process and reopen, or the old config stays in memory — the symptom is
  `tool notify is not enabled for server discord` in every new chat.

## License

Licensed under the [GNU General Public License v3.0](LICENSE).
