# spyglass

Drive a visible (non-headless) Chromium from Vibe over MCP. The browser runs on your machine, in a window you can watch while the agent navigates, clicks, types and takes screenshots.

Two transports:

- **stdio**, for the Vibe CLI (local process)
- **Streamable HTTP + bearer token**, for the Vibe web custom connector (needs an HTTPS URL)

No dependencies. Requires Node.js >= 22 and Chrome, Chromium, Edge or Brave.

## Quick start

```bash
git clone https://github.com/Breacher1337/spyglass
cd spyglass

node server.mjs navigate example.com   # launches a visible Chrome and opens the page
node server.mjs snapshot               # lists interactive elements as [ref=eN]
node server.mjs click e12
node server.mjs type e5 "hello world"
node server.mjs read
node server.mjs screenshot shot.png --full
node server.mjs status
```

If a browser with debugging enabled is already running on port 9222, it attaches instead of launching. Automation uses a dedicated profile (`~/.spyglass/profile`); your normal Chrome profile and windows are never touched.

## Tools

| Tool | What it does |
|---|---|
| `browser_status` | Browser and current tab state |
| `browser_navigate` | Open a URL in the current tab, or a new one |
| `browser_snapshot` | Compact page tree; interactive elements get refs like `[ref=e12]` |
| `browser_read` | Readable page text |
| `browser_click` | Click a ref (scrolls into view, real mouse events) |
| `browser_type` | Type text into a ref (or the focused element), optional Enter |
| `browser_press_key` | Key or combo: `Enter`, `Escape`, `Control+A` |
| `browser_scroll` | up / down / top / bottom |
| `browser_back` / `browser_forward` | History navigation |
| `browser_screenshot` | Screenshot (viewport or full page), returned as an image |
| `browser_tab_list` / `_new` / `_select` / `_close` | Tab management |
| `browser_wait` | Wait 100-10000 ms |
| `browser_evaluate` | Run JS in the page (escape hatch) |

Typical flow: `navigate` → `snapshot` → act on refs → `read` / `screenshot`.

Refs come from an in-page registry filled by `browser_snapshot`. A full navigation clears it; actions then return a friendly error telling the agent to snapshot again.

## Vibe CLI setup

```bash
vibe mcp add browser --transport stdio \
  --command node --arg /full/path/to/spyglass/server.mjs
```

Or in `config.toml`:

```toml
[[mcp_servers]]
name = "browser"
transport = "stdio"
command = "node"
args = ["/full/path/to/spyglass/server.mjs"]
```

## Vibe web setup

1. Start the server (token is generated and saved to `~/.spyglass/token`):

   ```bash
   node server.mjs --http --port 8765
   ```

2. Give it an HTTPS URL with [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (outbound tunnel, nothing binds publicly):

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8765
   ```

3. In Vibe: **Connectors → + Add Connector → Custom MCP Connector**
   - Name: `spyglass`
   - Server URL: `https://<tunnel-id>.trycloudflare.com/mcp`
   - Paste the token when prompted.

4. Optional: in the connector's **Functions** tab, set *Always allow* on the read tools (`browser_status`, `browser_snapshot`, `browser_read`, `browser_screenshot`, `browser_tab_list`, `browser_wait`) and keep the action tools on manual approval.

## Options

```
--http               MCP over Streamable HTTP (otherwise stdio, or one-shot CLI)
--port N             HTTP port (default 8765)
--token T            required HTTP bearer token
--token-file F       read the token from a file
--no-auth            disable HTTP auth (local tests only)
--browser-port N     Chrome debugging port (default 9222)
--chrome-path P      explicit browser binary
--profile-dir D      browser profile (default ~/.spyglass/profile)
--headless           headless mode (for CI)
--no-launch          attach only, never start a browser
```

Environment variables: `SPYGLASS_PORT`, `SPYGLASS_HTTP_PORT`, `SPYGLASS_HOST`, `SPYGLASS_TOKEN`, `SPYGLASS_CHROME_PATH`, `SPYGLASS_HEADLESS`, `SPYGLASS_NO_LAUNCH`.

## Notes

- Chrome's debugging endpoint binds to 127.0.0.1 only; the HTTP server also binds 127.0.0.1 by default and requires a bearer token. Never use `--host` to bind a public interface.
- Typing uses `Input.insertText` (IME-style). Fast and reliable, but for per-key hotkeys inside text fields use `browser_press_key`.
- The snapshot walker does not pierce shadow DOM yet.

## Test

```bash
node test/smoke.mjs   # 33 checks, no browser needed
```

## License

MIT
