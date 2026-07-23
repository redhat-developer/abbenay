# Configuration Guide

Abbenay uses YAML configuration files and system keychain for secrets.

## Config File Locations

### User Level
`~/.config/abbenay/config.yaml` - Applies globally to all workspaces

### Workspace Level
`<workspace>/.config/abbenay/config.yaml` - Workspace-specific settings (overrides user-level)

## Config File Format

```yaml
# HTTP API security (optional overrides — secure defaults apply without this block)
server:
  api_token_env: "ABBENAY_API_TOKEN"   # preferred: token from env (never commit secrets)
  # api_token: "..."                   # discouraged plaintext; prefer api_token_env
  host: "127.0.0.1"                    # default bind; use 0.0.0.0 only intentionally
  cors_origins:                        # extra allowed Origins (localhost always included)
    - "https://my-trusted-app.example"

providers:
  my-openai:                        # Virtual provider name (user-defined)
    engine: openai                  # Engine type (see Supported Engines below)
    api_key_keychain_name: "OPENAI_API_KEY"  # Option 1: keychain
    models:
      gpt-4o: {}                    # Enabled with defaults
      gpt-4o-mini:
        temperature: 0.3
        max_tokens: 4096
  
  anthropic-work:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"  # Option 2: env var
    models:
      claude-sonnet-4-20250514: {}
      claude-3-5-haiku-20241022:
        temperature: 0.7
  
  local-ollama:
    engine: ollama
    base_url: "http://127.0.0.1:11434/v1"   # Optional: custom base URL
    models:
      llama3.2: {}
      qwen2.5-coder:
        model_id: "qwen2.5-coder:7b"        # Map virtual name to actual model ID
```

### OpenAI-compatible tools (`openai_compat`) — DR-032

By default, `POST /v1/chat/completions` **ignores** request `tools` (secure
default from DR-019). Opt in to **passthrough** so clients like
[Open WebUI](https://docs.openwebui.com/) Native function calling can send
`tools`, receive structured `tool_calls`, and execute tools **themselves**.

| Level | Key | UI |
|-------|-----|-----|
| Global | `openai_compat.tools: off \| passthrough` | YAML only |
| Per model | `openai_compat_tools: off \| passthrough` | YAML for both values; dashboard **Configure model** checkbox only sets `passthrough` or clears the key (inherit global) |

Resolve order: **per-model → global → `off`**. To force a model `off` when
global is `passthrough`, set `openai_compat_tools: off` in YAML (the checkbox
cannot force `off`).

```yaml
openai_compat:
  tools: off                         # default — Cursor/aider/scripts stay tool-free on /v1

providers:
  openrouter:
    engine: openrouter
    models:
      anthropic/claude-sonnet-4: {}
      x-ai/grok-3:
        openai_compat_tools: passthrough   # Open WebUI Native FC for this model only
```

**Security tradeoff:** Passthrough trusts the client’s tool list and does not
use Abbenay’s approval UI. Prefer enabling it only on models you use with
trusted clients. For Abbenay-executed / approval-gated tools, use the dashboard,
gRPC, or MCP paths instead of `/v1`.

### HTTP API security (`server`)

The web dashboard, REST API (`/api/*`), OpenAI-compatible API (`/v1/*`), and
MCP endpoint (`/mcp`) require authentication by default. MCP tool calls also
honor `tool_policy` (same approval path as chat — see [Tool policy](#tool-policy)
below).

For air-gap / privacy claims vs real defaults, see
[SECURITY.md](./SECURITY.md). **Network isolation alone does not secure
Abbenay.**

| Setting / env | Purpose | Default |
|---------------|---------|---------|
| `ABBENAY_API_TOKEN` or `server.api_token` / `server.api_token_env` | Bearer token for all HTTP routes | Auto-generated and stored as `http-api-token` in the config directory |
| `ABBENAY_HTTP_AUTH` | Enable/disable HTTP auth | Enabled (`1` / unset). Set to `0`, `false`, `off`, `no`, or `disabled` to turn auth off |
| `ABBENAY_HTTP_HOST` or `server.host` or `--host` | HTTP bind address | `127.0.0.1` |
| `ABBENAY_CORS_ORIGINS` or `server.cors_origins` | Extra CORS allowed origins | `http://127.0.0.1:<port>`, `http://localhost:<port>` |
| `server.allowed_provider_hosts` | Optional host allowlist for provider `base_url` (non-loopback) | Unset — any `https` host allowed; `http` only to loopback |
| `server.allow_insecure_provider_http` | Allow `http://` provider endpoints to non-loopback hosts | `false` |

### Provider integrations & endpoint policy (finding A3)

Each LLM engine adds dependency and trust surface: a dedicated `@ai-sdk/*`
package (or shared `@ai-sdk/openai-compatible`), its own HTTP schemas, and
auth model (API key, AWS chain, Vertex ADC/Bearer, etc.). Abbenay loads those
packages **on demand**, but only from a **fixed in-code allowlist**
(`PROVIDER_LOADERS` / built-in engine IDs) — writable config **cannot**
install or `import()` an arbitrary npm package at runtime.

The residual A3 risk is configuring a **known** engine (often
openai-compatible) with a malicious `base_url` so prompts, responses, and
keys are sent to an attacker. That path is closed by auth on config writes
(DR-030 / DR-037 / H4 Zod) plus the endpoint policy below (DR-040).

Provider `base_url` values (configure wizard, `POST /api/config`, gRPC
`ConfigureProvider` / `UpdateConfig`, and model discovery) are validated
before use:

- Absolute URL with scheme `http` or `https` only; hostname required
- Credentials in the URL (`https://user:pass@…`) are rejected
- `http` is allowed only for loopback (`localhost`, `127.0.0.1`, `::1`,
  `*.localhost`) unless the host is listed in `allowed_provider_hosts` or
  `allow_insecure_provider_http: true`
- When `allowed_provider_hosts` is set, every non-loopback host must match
- Without `allowed_provider_hosts`, any `https` host is accepted; set the
  allowlist for Enterprise / air-gapped fleets
- `engine` must be a built-in engine ID (unknown engines are rejected)
- Successful endpoint changes are audited:
  `[Audit] provider endpoint changed: provider=… from=… to=… source=…`
- Dynamic provider registration cannot be done anonymously when auth is on

```yaml
server:
  # Tighten: only these hosts (plus loopback) may be used as provider endpoints
  allowed_provider_hosts:
    - "api.openai.com"
    - "maas.apps.cluster.example.com"
    - "10.0.0.5"          # also permits http://10.0.0.5/… (air-gapped)
  # Or, broader air-gapped trust (still prefer allowlist when possible):
  # allow_insecure_provider_http: true
```

**Supply-chain notes for operators:** keep dependencies locked and run
`npm run audit:check`; only add engines via code review / release (not via
config). Per-package SBOM pinning beyond the existing lockfile + audit
allowlist is out of scope for this finding’s runtime mitigations.

Call APIs with:

```bash
curl -H "Authorization: Bearer $ABBENAY_API_TOKEN" http://127.0.0.1:8787/api/health
```

Provider API keys for model discovery must never appear in query strings
(DR-035). Use `X-Api-Key` or a JSON body (daemon Bearer auth stays on
`Authorization`):

```bash
# Header
curl -H "Authorization: Bearer $ABBENAY_API_TOKEN" \
  -H "X-Api-Key: $GOOGLE_API_KEY" \
  http://127.0.0.1:8787/api/discover-models/gemini

# Body
curl -X POST -H "Authorization: Bearer $ABBENAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$GOOGLE_API_KEY\"}" \
  http://127.0.0.1:8787/api/discover-models/gemini
```

`GET/POST ...?apiKey=` is rejected (HTTP 400). Outbound Gemini calls use the
`x-goog-api-key` header, not `?key=` in the URL.

The dashboard uses SameSite=Strict cookies plus a CSRF token for browser
session auth. Open `http://127.0.0.1:8787/login` (or `POST /login` with the
token in the body) to establish a session — prefer that over putting the
token in the URL. Cookies include the `Secure` flag when the request is
HTTPS or arrives via a TLS-terminated proxy (`X-Forwarded-Proto: https`).
Binding to `0.0.0.0` requires an explicit opt-in and logs a warning — only
do this when you intentionally expose the HTTP API (e.g. containers) and
have set a strong token.

When auth is enabled, unauthenticated browser requests to `/` (or `/index.html`)
redirect to `/login` unless both the TCP peer and the browser `Host` /
`X-Forwarded-Host` are localhost (direct local use). That way a reverse proxy
that connects over loopback still cannot auto-establish a session for a public
hostname. API routes (`/api/*`, `/v1/*`, `/mcp`) continue to return `401` JSON
when unauthenticated.

> **WARNING — disabling HTTP auth:** Auth is **on by default**. Setting
> `ABBENAY_HTTP_AUTH=0` turns it off on any bind address (including
> `--host 0.0.0.0`). That allows any process (and any website that can reach
> this port) to call the daemon and read/write secrets, config, chat, MCP,
> and sessions. The server logs a loud warning when auth is disabled.
>
> Legitimate cases for auth-off on a non-loopback bind include:
> - **Cluster / production pod** — Abbenay as an internal Service, reachable
>   only on a private network (NetworkPolicy, mesh, or equivalent), with no
>   public ingress to the daemon port
> - **Auth at the proxy** — a reverse proxy, API gateway, or ingress that
>   already authenticates callers (OAuth2 proxy, mesh mTLS, corporate SSO)
>   and forwards only trusted traffic to Abbenay
>
> Auth-off disables Abbenay’s Bearer **and** dashboard CSRF checks. Abbenay
> does not verify proxy-injected identity headers; isolation must come from
> the network (who can reach the port). See
> [CONTAINER.md](CONTAINER.md#security-http-bind-and-authentication) for
> sketch examples. If neither shape applies, keep auth enabled and use a
> strong `ABBENAY_API_TOKEN`.

### Tool policy

`tool_policy` in `config.yaml` applies to **chat** and to tools invoked through
Abbenay's MCP HTTP endpoint (`POST /mcp`). Both use the same validator
(`createToolValidator` — DR-033).

```yaml
tool_policy:
  disabled_tools: ['mcp:dangerous/*']   # Rejected; never listed for chat
  auto_approve: ['local:agent/echo']    # Runs without prompting
  require_approval: ['local:agent/danger']  # Blocks until user approves
```

| Outcome | Chat | MCP HTTP (`/mcp`) |
|---------|------|-------------------|
| `disabled_tools` | Tool omitted from LLM | `tools/call` returns error; executor not run |
| `auto_approve` | Runs immediately | Runs immediately |
| `require_approval` / default ask | SSE `approval_request`; `POST /api/chat/:chatId/approve` | Request blocks; dashboard / `GET|POST /api/mcp/approvals` |
| Denied / abort | Tool skipped or loop aborted | `tools/call` returns `isError` |

Unauthenticated `POST/GET/DELETE /mcp` is rejected with `401` (DR-030).

### MCP client connection consent

Bearer auth alone is not enough to open an MCP session. On `initialize`, Abbenay
creates a pending connection consent (DR-034). The dashboard (or
`GET/POST /api/mcp/connections`) must allow the client before a
`Mcp-Session-Id` is issued. Subsequent `tools/call` requests without that
session header are rejected with `403`.

| Action | API |
|--------|-----|
| List pending + active sessions + remembered | `GET /api/mcp/connections` |
| Allow / deny (optional `remember: true`) | `POST /api/mcp/connections/:requestId` |
| Revoke session | `DELETE /api/mcp/connections/sessions/:sessionId` |
| Forget remembered client | `DELETE /api/mcp/connections/remembered/:clientName` |

`remember: true` is a DX shortcut keyed on `clientInfo.name` for the daemon
lifetime. Empty names and the placeholder `unknown-client` are never
remembered. Remember is not strong client identity — any API-token holder can
present a remembered name, and the same token can both call `/mcp` and approve
via `/api/mcp/connections`. Pending connection consents and tool approvals
auto-deny after **5 minutes** if the user never responds, so abandoned
`initialize` / `tools/call` requests cannot leak entries in the pending maps.

### Stdio MCP spawn policy (`security`) — DR-043

Dynamic `RegisterMcpServer` with `transport: stdio` can spawn a local process.
That path is fail-closed:

1. **Allowlist** — `command` must match `security.stdio_command_allowlist`
   (basename or absolute path). An empty / omitted allowlist denies all
   dynamic stdio spawns.
2. **Operator approval** — even allowlisted commands wait for an explicit
   Allow on the dashboard (or `POST /api/mcp/stdio-spawns/:requestId`) unless
   `stdio_require_approval: false`.
3. **Auth** — when `consumers` is configured, stdio registration requires a
   matching consumer token with `mcp_register`. Unauthenticated callers cannot
   supply `command` / `args`.

Config-file `mcp_servers` entries are admin-authored and skip the allowlist /
approval gates (writing them to YAML is the approval). Prefer HTTP/SSE for
dynamic registration when the caller can start its own MCP server.

```yaml
security:
  max_dynamic_mcp_servers: 10
  stdio_command_allowlist:
    - npx
    - uvx
    - /usr/local/bin/my-trusted-mcp
  stdio_require_approval: true     # default; set false only for trusted automation
```

| API / UI | Purpose |
|----------|---------|
| `GET /api/mcp/stdio-spawns` | Pending spawn approvals + recent denials |
| `POST /api/mcp/stdio-spawns/:requestId` | `{ "decision": "allow" \| "deny" }` |
| Dashboard → MCP Servers | Pending stdio spawn cards + denial list |

Denied registrations return a clear gRPC/`PERMISSION_DENIED` reason and are
logged as `[StdioMCP] DENIED: …` (also listed under recent denials in the UI).

### Consumer authentication (`consumers`) — DR-037

Named consumer applications authenticate to gRPC with a token in the
`x-abbenay-token` metadata header. Each consumer is granted a capability
matrix; sensitive RPCs require both a matching token and the relevant flag.

```yaml
consumers:
  apme:
    token_env: "APME_TOKEN"          # env var holding the consumer token
    # token_keychain: "APME_TOKEN"   # future: keychain-backed token
    capabilities:
      chat: true                     # Chat / SessionChat / SummarizeSession
      inline_policy: true            # PolicyConfig on chat requests
      mcp_register: true             # RegisterMcpServer / UnregisterMcpServer
      secrets: true                  # Get/Set/Delete/ListSecret, GetKeyStatus
      config: true                   # Get/UpdateConfig, policy CRUD, web start/stop
      providers: true                # ConfigureProvider / RemoveProvider / DiscoverModels
      shutdown: true                 # Shutdown RPC
```

| Capability | Gated RPCs |
|------------|------------|
| `chat` | `Chat`, `SessionChat`, `SummarizeSession` |
| `inline_policy` | Inline `PolicyConfig` on chat (also needs `chat`) |
| `mcp_register` | `RegisterMcpServer`, `UnregisterMcpServer`, `ReconnectMcpServer` |
| `secrets` | `GetSecret`, `SetSecret`, `DeleteSecret`, `ListSecrets`, `GetKeyStatus` |
| `config` | `GetConfig`, `UpdateConfig`, `CreatePolicy`, `DeletePolicy`, `StartWebServer`, `StopWebServer` |
| `providers` | `ConfigureProvider`, `RemoveProvider`, `DiscoverModels` |
| `shutdown` | `Shutdown` |

**Behavior:**

| Bind / config | Empty `consumers` | `consumers` configured |
|---------------|-------------------|------------------------|
| Unix socket or loopback TCP (`127.0.0.1`, `::1`) | Allow-all (local DX) | Token + capability required for sensitive RPCs |
| Non-loopback TCP (`0.0.0.0`, LAN IP, …) | **Refuse to start** unless `--allow-open-auth` or `--insecure` | Token + capability required |

Token comparison uses `crypto.timingSafeEqual` (equal-length buffers). Wrong
or missing tokens receive `PERMISSION_DENIED`. Health/status/list discovery
RPCs stay ungated so probes and local tooling keep working.

> **WARNING — open auth:** `--allow-open-auth` (or `--insecure`, which implies
> it) on a non-loopback bind restores allow-all when `consumers` is empty.
> Prefer configuring consumers. HTTP API auth is separate (`server` / Bearer);
> see above.

### Session ownership

Every session is stamped with an `owner` principal:

| Surface | Owner |
|---------|--------|
| CLI (`aby chat` / `aby sessions`) | `local` |
| HTTP API (Bearer / dashboard cookie) | `http:<token-fingerprint>` |
| HTTP + `X-Abbenay-Session-Owner: <name>` | `http:<fingerprint>:<name>` |
| gRPC with matching consumer token | `consumer:<name>` |
| gRPC without consumer token | `local` |

List/get/delete/chat only return sessions for the caller's owner. Cross-owner
access returns 404 (not 403) so session IDs are not leaked across principals.
Legacy sessions without an `owner` field are treated as `local`.

### Key Concepts

- **Virtual provider name** - The YAML key (e.g., `my-openai`). User-defined, must be lowercase alphanumeric with dots, hyphens, or underscores.
- **Engine** - The actual API backend (`openai`, `anthropic`, `ollama`, etc.). Fixed set defined in `core/engines.ts`.
- **Virtual model name** - The YAML key under `models`. Usually matches the engine model ID, but can be a custom alias via `model_id`.
- **Composite ID** - `{provider}/{model}` (e.g., `my-openai/gpt-4o`). Used in chat requests.

## API Key Storage Options

Each provider can specify exactly ONE of these (mutually exclusive):

### Option 1: Keychain Storage (`api_key_keychain_name`)

- Key stored in system keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- Specify the key name used in keychain
- Set via web dashboard "API Key" toggle

```yaml
providers:
  my-openai:
    engine: openai
    api_key_keychain_name: "OPENAI_API_KEY"
```

### Option 2: Environment Variable (`api_key_env_var_name`)

- Key read from environment variable at runtime
- Specify the env var name to check
- Set via web dashboard "Env" toggle

```yaml
providers:
  anthropic-work:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"
```

### Fallback

If neither option is set, the engine's default environment variable is checked (e.g., `OPENAI_API_KEY` for the `openai` engine).

## Supported Engines

| Engine | ID | Default Env Var | Key Required |
|--------|----|-----------------|-------------|
| OpenAI | `openai` | `OPENAI_API_KEY` | Yes |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | Yes |
| Google Gemini | `gemini` | `GOOGLE_API_KEY` | Yes |
| Mistral | `mistral` | `MISTRAL_API_KEY` | Yes |
| xAI (Grok) | `xai` | `XAI_API_KEY` | Yes |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | Yes |
| Groq | `groq` | `GROQ_API_KEY` | Yes |
| Cohere | `cohere` | `COHERE_API_KEY` | Yes |
| Amazon Bedrock | `bedrock` | *(AWS credentials)* | No |
| Vertex Anthropic | `vertex-anthropic` | `VERTEX_ANTHROPIC_API_KEY` | No |
| Fireworks | `fireworks` | `FIREWORKS_API_KEY` | Yes |
| Together AI | `togetherai` | `TOGETHER_AI_API_KEY` | Yes |
| Perplexity | `perplexity` | `PERPLEXITY_API_KEY` | Yes |
| Azure OpenAI | `azure` | `AZURE_OPENAI_API_KEY` | Yes |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Yes |
| Ollama | `ollama` | *(none needed)* | No |
| LM Studio | `lmstudio` | *(none needed)* | No |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` | Yes |
| Meta (Llama) | `meta` | `META_API_KEY` | Yes |
| Red Hat AI | `redhat` | `REDHAT_AI_API_KEY` | No |
| Mock (Testing) | `mock` | *(none needed)* | No |

## Per-Model Configuration

Each model entry supports these optional fields:

| Field | Type | Description |
|-------|------|-------------|
| `model_id` | string | Actual engine model ID (when the key is a virtual alias) |
| `system_prompt` | string | System prompt text |
| `system_prompt_mode` | `"prepend"` \| `"replace"` | How to combine with request system prompt (default: `"prepend"`) |
| `temperature` | number | Sampling temperature (0.0 - 2.0) |
| `top_p` | number | Nucleus sampling (0.0 - 1.0) |
| `top_k` | number | Top-k sampling |
| `max_tokens` | number | Maximum output tokens |
| `timeout` | number | Request timeout in milliseconds (mapped to AI SDK `{ totalMs }`; total budget only) |
| `reasoning` | string | Optional AI SDK 7 reasoning effort: `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Passed through to the model; reasoning deltas are not streamed to clients yet. |

An empty object `{}` means "enabled with all defaults."

## Web Dashboard Configuration

The easiest way to configure Abbenay is via the web dashboard:

1. Start the daemon: `npm run daemon` (or `abbenay daemon` / `aby daemon`)
2. Start the web server: `npm run web` (or `abbenay web` / `aby web`)
3. Open http://localhost:8787

### Provider Cards

Each provider shows:
- **Name**: Virtual provider name
- **Engine**: The underlying API backend
- **Toggle**: Choose "Key" (keychain) or "Env" (environment variable)
- **Input field**: Enter API key value (for keychain) or env var name
- **Status badge**: "Configured", "Key missing", or "Not configured"
- **Model selection**: Choose which models to enable

### Config Location

Click the settings icon to choose where config is saved:
- **User**: `~/.config/abbenay/config.yaml` (default)
- **Workspace**: `<workspace>/.config/abbenay/config.yaml` (requires VS Code connection)

HTTP `POST /api/config` validates the body with Zod (`ConfigFile` shape) and
only allows workspace `location` values that match a currently connected /
allowlisted workspace path. Path traversal (`..`) and unknown locations are
rejected with no file write.

## VS Code Extension

The VS Code extension:
- Connects to the daemon automatically
- Provides workspace paths for workspace-level config
- Registers configured models with VS Code's Language Model API

No configuration is stored in the extension itself.

## CLI Configuration

### View Status
```bash
# From packages/daemon
npm run status

# Or with compiled binary
abbenay status
```

### Start Services
```bash
# Development
npm run daemon    # Start daemon (foreground)
npm run web       # Start web dashboard

# Production (aby is a short alias for abbenay)
abbenay daemon &
abbenay web
aby status
```

## Example Configurations

### Minimal (Single Provider)
```yaml
providers:
  openai:
    engine: openai
    api_key_env_var_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
```

### Multiple Providers
```yaml
providers:
  openai:
    engine: openai
    api_key_keychain_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
      gpt-4o-mini: {}
  
  anthropic:
    engine: anthropic
    api_key_keychain_name: "ANTHROPIC_API_KEY"
    models:
      claude-sonnet-4-20250514: {}
  
  local:
    engine: ollama
    models:
      llama3.2: {}
      qwen2.5-coder:
        model_id: "qwen2.5-coder:7b"
```

### Multiple Instances of Same Engine
```yaml
providers:
  work-openai:
    engine: openai
    api_key_env_var_name: "WORK_OPENAI_KEY"
    base_url: "https://corp-proxy.example.com/v1"
    models:
      gpt-4o: {}

  personal-openai:
    engine: openai
    api_key_keychain_name: "PERSONAL_OPENAI_KEY"
    models:
      gpt-4o: {}
      gpt-4o-mini: {}
```

### Local Development (All from Env Vars)
```yaml
providers:
  openai:
    engine: openai
    api_key_env_var_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
  
  anthropic:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    models:
      claude-sonnet-4-20250514: {}
```

### Red Hat AI (Inference Server / MaaS)

```yaml
# Profile A — Inference Server (local or OpenShift-hosted vLLM)
providers:
  redhat-inference:
    engine: redhat
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}

# Profile B — OpenShift AI MaaS (enterprise gateway)
  redhat-maas:
    engine: redhat
    base_url: "https://maas.apps.cluster.example.com/v1"
    api_key_env_var_name: "REDHAT_AI_API_KEY"
    models:
      llama-3.1-8b-instruct: {}
```

Inference Server auth is optional (depends on `--api-key` flag); MaaS
typically requires an API key. Default endpoint: `http://127.0.0.1:8000/v1`.
See [REDHAT_AI.md](REDHAT_AI.md) for full setup including both profiles.

### Vertex-Hosted Anthropic (Bearer Token Proxy)

For corporate Vertex AI proxies that authenticate via Bearer token instead of
Google Cloud ADC:

```yaml
providers:
  corp-vertex:
    engine: vertex-anthropic
    base_url: "https://your-proxy.example.com/sonnet/models"
    api_key_env_var_name: "VERTEX_ANTHROPIC_API_KEY"  # reads Bearer token from env
    models:
      claude-sonnet-4:
        model_id: "claude-sonnet-4@20250514"
```

Set the environment variable to your Bearer token:

```bash
export VERTEX_ANTHROPIC_API_KEY="your-bearer-token-here"
```

The `base_url` should include the full path prefix up to `/models` (the engine
appends `/<model-id>:streamRawPredict` automatically). When no API key is
configured, the engine falls back to standard Google Cloud Application Default
Credentials.

For proxies with self-signed or internal CA certificates, set the standard
Node.js `NODE_EXTRA_CA_CERTS` environment variable to the CA bundle path.

If your proxy returns streaming responses as `application/json`, note that
Abbenay only converts text-only content blocks to SSE. Responses containing
`tool_use` blocks are passed through unchanged, so tool calling may not work in
this proxy mode. If you need tool calling via a proxy, prefer a proxy that
returns `text/event-stream`.

### Vertex Anthropic (Google Cloud ADC)

For standard Vertex AI with Google Cloud authentication:

```yaml
providers:
  vertex-claude:
    engine: vertex-anthropic
    models:
      claude-sonnet-4:
        model_id: "claude-sonnet-4@20250514"
```

Set `GOOGLE_VERTEX_PROJECT` and `GOOGLE_VERTEX_LOCATION` environment variables,
and ensure Google Cloud ADC is configured (e.g., via `GOOGLE_APPLICATION_CREDENTIALS`).

## Best Practices

### Personal Development
- Use keychain storage for API keys (secure, persistent)
- Configure via web dashboard for easy management

### Team Projects
- Use workspace-level config (`.config/abbenay/config.yaml`)
- Reference env vars for API keys
- Team members set their own env vars
- Commit config file, add env var docs to README

### CI/CD
- Use environment variables for API keys
- Set `api_key_env_var_name` in config
- Pass secrets via CI/CD platform

### Security
- Never commit API keys to version control
- Use keychain for local development
- Use env vars for CI/CD and containers

## Credential aggregation risk (operators) — finding A1

Abbenay **centralizes** API keys for 20+ LLM providers in a single daemon
(keychain and/or env vars referenced from one config). If the daemon host or
an authenticated secret/config surface is compromised, **all** configured
provider credentials can be exposed at once. That is a **larger blast radius**
than per-extension credential storage (where compromising one editor
extension typically yields only that extension’s keys).

Primary personas — **Enterprise Developers**, **Security-Conscious
Developers**, and operators in **air-gapped** environments — require that this
tradeoff be explicit and that controls reduce (not ignore) the risk. The
mitigations below are the current posture; stronger isolation
(encryption-at-rest beyond OS keychain, process separation) is deferred
(DR-040).

Related: a writable config that points `base_url` at a malicious host can
steal prompts/responses/keys — constrained by the
[provider endpoint policy](#provider-integrations--endpoint-policy-finding-a3)
(finding A3 / DR-040).

### Mitigations in place

| Control | What it does |
|---------|----------------|
| OS keychain (`keytar`) / env refs | Secrets are not stored in plaintext YAML |
| Config files mode `0600` | User-only read/write on disk |
| HTTP Bearer auth (DR-030) | Unauthenticated callers cannot read/write secrets or configure providers |
| gRPC consumer capabilities (DR-037) | On non-localhost binds, sensitive RPCs require token + capability (`secrets`, `providers`, `config`, `mcp_register`, …) |
| Secret API shape | HTTP `GET /api/secrets` returns key names + `hasValue` only — never secret values. gRPC `GetSecret` (value-returning) requires the `secrets` capability |
| Secret / endpoint audit logs | `[Audit] secret changed` and `[Audit] provider endpoint changed` (never log secret values) |
| Provider endpoint policy (DR-040) | Malformed / disallowed `base_url` values are rejected; changes are audited |
| Localhost bind defaults | HTTP/gRPC default to loopback; non-loopback requires intentional opt-in |

Dynamic provider registration (`ConfigureProvider` / dashboard configure) and
dynamic MCP registration (`RegisterMcpServer`) **cannot** be performed
anonymously when auth is enabled / consumers are configured.

### Guidance by persona

| Persona | Recommended posture |
|---------|---------------------|
| Enterprise / air-gapped | Bind loopback or trusted network only; configure `consumers` for gRPC; set `server.allowed_provider_hosts` to approved gateways; prefer env/secrets-manager injection over long-lived dashboard tokens |
| Security-conscious workstation | Keychain storage; keep HTTP auth on; do not disable `ABBENAY_HTTP_AUTH`; treat `ABBENAY_API_TOKEN` like a password-manager master secret |
| Local DX / single user | Defaults (loopback + auto token + keychain) are acceptable; still rotate keys if the host may have been exposed |

### Operator checklist

1. Treat the daemon host and API token as **high value** — same tier as a
   password manager holding multiple cloud keys.
2. Prefer keychain storage on interactive workstations; prefer env vars (or
   a secrets manager injecting env) in CI/containers.
3. Keep HTTP/gRPC on loopback unless you need remote access; then require
   strong tokens and (for gRPC) a `consumers` section with least-privilege
   capabilities (grant `secrets` / `providers` only to callers that need them).
4. For enterprise / air-gapped fleets, set `server.allowed_provider_hosts` to
   the approved inference gateways only.
5. Review audit logs for `[Audit] secret changed` and
   `[Audit] provider endpoint changed` after config changes or suspected
   compromise.
6. Rotate **all** provider API keys if the daemon host or `ABBENAY_API_TOKEN`
   may have been exposed — aggregation means one incident can touch every
   configured provider.

### Deferred: encryption-at-rest / stronger isolation

Per-secret encryption-at-rest beyond the OS keychain, and process-level
isolation of secrets, are **deferred** (recorded in DR-040). Revisit when
there is a concrete enterprise requirement; current controls rely on OS
keychain/env, filesystem permissions, auth gates, audit logs, and endpoint
policy — not on eliminating aggregation itself.
