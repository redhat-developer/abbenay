# Getting Started with Abbenay

This guide walks you through installing, configuring, and using Abbenay.

---

## 1. Install

### Option A: Pre-built binary (recommended)

Download the latest release for your platform. The binary is a
[Node.js Single Executable Application (SEA)](https://nodejs.org/api/single-executables.html) —
no Node.js installation required.

Release artifacts are named `abbenay-daemon-<platform>-<arch>`. Rename
or symlink to `aby` for convenience:

```bash
# Linux / macOS — rename and move to PATH
chmod +x abbenay-daemon-linux-x64
sudo mv abbenay-daemon-linux-x64 /usr/local/bin/aby
```

If you install via npm (`npm install -g @abbenay/daemon`), both `aby`
and `abbenay` are available on PATH automatically.

All examples in this guide use `aby`.

### Option B: Build from source

```bash
git clone https://github.com/redhat-developer/abbenay.git
cd abbenay

./bootstrap.sh                 # downloads Node.js + uv into .build-tools/
source .build-tools/env.sh     # puts them on PATH
npm install
node build.js                  # builds SEA binary + VSIX + dist archives
```

### Option C: Container image

```bash
git clone https://github.com/redhat-developer/abbenay.git
cd abbenay
podman build -f Containerfile -t abbenay:latest .

podman run -d --name abbenay \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  -p 8787:8787 \
  abbenay:latest
```

See [CONTAINER.md](CONTAINER.md) for full container deployment docs
including Kubernetes manifests.

### Option D: Run from source (development)

```bash
git clone https://github.com/redhat-developer/abbenay.git
cd abbenay
npm install
cd packages/daemon
npx tsx src/daemon/index.ts daemon   # run daemon directly
```

---

## 2. Configure a provider

Abbenay needs at least one LLM provider. Create a config file at the
platform-appropriate location:

| Platform | Config directory |
|----------|----------------|
| Linux | `$XDG_CONFIG_HOME/abbenay/` (default `~/.config/abbenay/`) |
| macOS | `~/Library/Application Support/abbenay/` |
| Windows | `%APPDATA%\abbenay\` |

```bash
# Linux example
mkdir -p ~/.config/abbenay
```

**`config.yaml`:**

```yaml
providers:
  my-openai:
    engine: openai
    api_key_env_var_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
      gpt-4o-mini: {}
```

Set the API key in your environment:

```bash
export OPENAI_API_KEY="sk-..."
```

Or use the system keychain instead of env vars:

```yaml
providers:
  my-openai:
    engine: openai
    api_key_keychain_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
```

Then store the key via the web dashboard or CLI.

### Local models (no API key needed)

```yaml
providers:
  local-ollama:
    engine: ollama
    models:
      llama3.2: {}
      qwen2.5-coder: {}
```

Ollama must be running at `http://localhost:11434` (the default).

### Red Hat AI (Inference Server or MaaS)

```yaml
providers:
  redhat-inference:
    engine: redhat
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

The Inference Server must be running at `http://127.0.0.1:8000/v1`. For
OpenShift AI MaaS, set `base_url` and `api_key_env_var_name`. See
[REDHAT_AI.md](REDHAT_AI.md) for both profiles.

See [CONFIGURATION.md](CONFIGURATION.md) for all options.

---

## 3. Start Abbenay

### All-in-one

```bash
aby start
```

This launches the daemon, web dashboard, OpenAI-compatible API, and MCP
server on port 8787.

### Individual services

```bash
aby daemon                    # gRPC daemon only (background-ready)
aby web -p 8787               # Web dashboard
aby serve -p 8787             # OpenAI-compatible API
aby status                    # Check if running
aby stop                      # Stop everything
```

---

## 4. Chat from the CLI

```bash
aby chat -m my-openai/gpt-4o
```

The model ID is `<provider-name>/<model-name>` from your config.

Options:

```bash
aby chat -m my-openai/gpt-4o -s "You are a helpful assistant"   # system prompt
aby chat -m my-openai/gpt-4o -p coder                          # apply a policy
aby chat -m my-openai/gpt-4o --no-tools                        # disable tools
aby chat -m my-openai/gpt-4o --json                            # JSON output (for piping)
```

Type your message and press Enter to send. Ctrl+D to exit.

---

## 5. Use sessions for persistent conversations

Sessions save your conversation so you can resume later.

```bash
# Start a new session
aby chat -m my-openai/gpt-4o --session new

# Resume an existing session
aby chat --session <session-id>

# List all sessions
aby sessions list

# Show a session's messages
aby sessions show <session-id>

# Delete a session
aby sessions delete <session-id>
```

Sessions are stored as JSON in a platform-specific data directory:

| Platform | Session directory |
|----------|------------------|
| Linux | `$XDG_DATA_HOME/abbenay/sessions/` (default `~/.local/share/abbenay/sessions/`) |
| macOS | `~/Library/Application Support/abbenay/sessions/` |
| Windows | `%LOCALAPPDATA%\abbenay\sessions\` |

Every 10 user messages, a background LLM call generates a short summary.

---

## 6. Use the OpenAI-compatible API

Start the server:

```bash
aby serve -p 8787
```

HTTP routes require a Bearer token (`ABBENAY_API_TOKEN`, `server.api_token`, or
the auto-generated `http-api-token` in your config directory):

```bash
# List models
curl -H "Authorization: Bearer $ABBENAY_API_TOKEN" \
  http://127.0.0.1:8787/v1/models

# Chat (streaming)
curl -H "Authorization: Bearer $ABBENAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8787/v1/chat/completions \
  -d '{
    "model": "my-openai/gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

Point any OpenAI-compatible client at `http://127.0.0.1:8787/v1` and use the
same token as the API key.

> **WARNING:** HTTP auth is **enabled by default**. For throwaway local
> development only you may set `ABBENAY_HTTP_AUTH=0` to skip Bearer tokens.
> The server logs a warning. Combining that with `--host 0.0.0.0` refuses to
> start. Prefer keeping auth on and using `ABBENAY_API_TOKEN` instead.

### With the OpenAI Python SDK

```python
from openai import OpenAI
import os

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key=os.environ["ABBENAY_API_TOKEN"],
)
response = client.chat.completions.create(
    model="my-openai/gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### With Cursor / Continue / aider

Set the API base URL to `http://127.0.0.1:8787/v1` in your tool's
settings. Use your Abbenay HTTP API token as the API key.

---

## 7. Use the web dashboard

```bash
aby web
```

Open http://127.0.0.1:8787 in your browser (loopback clients with a localhost
Host get a session automatically). On remote binds (`--host 0.0.0.0`),
unauthenticated **non-local** visits to `/` redirect to `/login` — for example
LAN or reverse-proxy hostnames — while a direct loopback peer with a localhost
Host can still auto-establish a session. Sign in with the API token (or
`POST /login` with the token in the body). Avoid putting the token in the query
string (it can leak via history, Referer, and logs).

For throwaway local development only, `ABBENAY_HTTP_AUTH=0` disables HTTP auth
(loopback bind only; refused with `--host 0.0.0.0`).

Use the dashboard to:

- Add and configure providers
- Store API keys in the system keychain
- Enable/disable models
- Test chat with streaming responses

Sessions created before ownership was introduced have no `owner` field and
are treated as CLI/`local` only — HTTP API clients will not list or open them.

---

## 8. Connect MCP servers

Abbenay can connect to external [MCP](https://modelcontextprotocol.io/)
servers and aggregate their tools.

Add to your config:

```yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    enabled: true
  github:
    transport: http
    url: http://localhost:3001/mcp
    enabled: true
```

Tools from connected MCP servers are automatically available in chat.
Tool approval policies control which tools can execute without
confirmation.

Dynamic registration via gRPC (`RegisterMcpServer`) with `transport: stdio`
is gated: the command must be in `security.stdio_command_allowlist`, and the
operator must approve the spawn in the dashboard (see
[CONFIGURATION.md](CONFIGURATION.md#stdio-mcp-spawn-policy-security--dr-038)).
Prefer HTTP/SSE when the caller starts its own MCP server.

### Expose Abbenay as an MCP server

With `--mcp`, Abbenay also serves aggregated tools at `POST /mcp` for
external MCP clients. That endpoint requires:

1. The same Bearer token as other HTTP routes
2. **Explicit connection consent** on `initialize` (dashboard → Pending MCP
   client connections, or `POST /api/mcp/connections/:id`)
3. `tool_policy` on every `tools/call` (same approval path as chat)

After you allow a connection, use the `Mcp-Session-Id` from the initialize
response on later requests. Tools that need consent appear under
**Pending MCP tool approvals**.

```bash
aby start --mcp -p 8787
# Client: Authorization: Bearer $ABBENAY_API_TOKEN → http://127.0.0.1:8787/mcp
# Approve the client in the dashboard, then send Mcp-Session-Id on tools/call
```

---

## 9. VS Code integration

Install the Abbenay VS Code extension (VSIX):

```bash
node build.js --code-install
```

The extension:
- Connects to the daemon automatically on activation
- Registers all configured models with VS Code's Language Model API
- Other extensions can use Abbenay models via `vscode.lm.selectChatModels({ vendor: 'abbenay' })`

---

## 10. Discover models

```bash
# Show configured models
aby list-models

# Discover what an engine offers (fetches from provider API)
aby list-models --discover ollama
aby list-models --discover openai
aby list-models --discover anthropic

# Show available engines
aby list-engines
```

---

## Next steps

- [Configuration Reference](CONFIGURATION.md) — all config options
- [Core Library API](CORE.md) — use `@abbenay/core` in your own apps
- [Architecture](ARCHITECTURE.md) — how the system fits together
- [Roadmap](ROADMAP.md) — what's coming next
