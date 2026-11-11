# discord-mcp

A single-tool MCP server that lets an AI agent ping me on Discord: `notify(message)`.

Works two ways from the same code:

| Transport | Entry point | Used by |
|---|---|---|
| Streamable HTTP (stateless) | `api/mcp.js` on Vercel | ChatGPT, remote clients |
| stdio | `mcp.js` | OpenCode, Antigravity, anything local |

No dependencies. Node's built-in `fetch` does the Discord call.

## Tools

`notify({ message })` → posts to one Discord channel, returns the message id.
Long text is split at 1900 characters (Discord's limit is 2000), with one retry on a 429.

## Environment

| Var | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from the Discord developer portal |
| `DISCORD_CHANNEL_ID` | Target channel |
| `MCP_TOKEN` | Shared secret; HTTP requests need `Authorization: Bearer <MCP_TOKEN>` |

Locally, `mcp.js` loads these from `../blackboard-discord-bot/.env` if they are not already in the
environment (override the path with `DISCORD_ENV_PATH`). Nothing is hardcoded in this repo.

## Deploy

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

## Client config

OpenCode (`~/.config/opencode/opencode.jsonc`):

```jsonc
"mcp": {
  "discord": {
    "type": "remote",
    "url": "https://<project>.vercel.app/api/mcp",
    "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
  }
}
```

Antigravity (`~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "discord": {
      "serverUrl": "https://<project>.vercel.app/api/mcp",
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
node lib/core.js                     # offline self-check, no network
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp.js
```

## Notes

- Discord rejects requests with a weak `User-Agent` using `403 {"code":40333,"internal network error"}`.
  Every request here sets one explicitly — if you fork this and see that error, it is the header, not permissions.
- Anyone holding the URL and `MCP_TOKEN` can post to the channel. There is no per-user auth; the
  token is the whole gate.
