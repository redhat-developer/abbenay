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

### Option C: Run from source (development)

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

Then point any OpenAI-compatible client at it:

```bash
# List models
curl http://localhost:8787/v1/models

# Chat (streaming)
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-openai/gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### With the OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="unused")
response = client.chat.completions.create(
    model="my-openai/gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### With Cursor / Continue / aider

Set the API base URL to `http://localhost:8787/v1` in your tool's
settings. The API key field can be any non-empty string.

---

## 7. Use the web dashboard

```bash
aby web
```

Open http://localhost:8787 in your browser to:

- Add and configure providers
- Store API keys in the system keychain
- Enable/disable models
- Test chat with streaming responses

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
