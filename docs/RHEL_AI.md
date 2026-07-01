# RHEL AI Provider

Abbenay includes a dedicated `rhel-ai` engine for connecting to
[Red Hat AI Inference Server](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux_ai/3.4/html-single/getting_started/getting_started),
the vLLM-based inference server included in RHEL AI 3.4+.

RHEL AI Inference Server exposes an OpenAI-compatible REST API, so Abbenay
routes it through `@ai-sdk/openai-compatible` — no additional SDK packages
are required.

---

## Quick Start

### 1. Start your RHEL AI Inference Server

The server must be running and serving at least one model. The default
local endpoint is `http://127.0.0.1:8000/v1`.

Verify it responds:

```bash
curl http://127.0.0.1:8000/v1/models
```

### 2. Configure Abbenay

Add a provider to your config file
(`~/.config/abbenay/config.yaml` on Linux,
`~/Library/Application Support/abbenay/config.yaml` on macOS):

```yaml
providers:
  rhel-ai-local:
    engine: rhel-ai
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

Replace `RedHatAI/Llama-3.2-1B-Instruct-FP8` with the model ID reported
by your server's `/v1/models` endpoint.

### 3. Start Abbenay and chat

```bash
aby start
aby chat -m rhel-ai-local/RedHatAI/Llama-3.2-1B-Instruct-FP8
```

---

## Authentication

RHEL AI Inference Server supports optional API key authentication via the
`--api-key` flag. Abbenay handles both cases:

### No authentication (default)

When the server is started without `--api-key`, no API key fields are
needed in the config:

```yaml
providers:
  rhel-ai-local:
    engine: rhel-ai
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

### API key enabled

When the server is started with `--api-key`, configure an API key via
environment variable or system keychain:

```yaml
# Option A: environment variable
providers:
  rhel-ai-local:
    engine: rhel-ai
    api_key_env_var_name: "RHEL_AI_API_KEY"
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

```yaml
# Option B: system keychain
providers:
  rhel-ai-local:
    engine: rhel-ai
    api_key_keychain_name: "RHEL_AI_API_KEY"
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

Then set the key:

```bash
# For env var:
export RHEL_AI_API_KEY="your-api-key"

# For keychain: use the web dashboard or CLI to store it
```

If the server requires a key and none is provided, you will receive a
`401 Unauthorized` response.

---

## Custom Base URL

The default base URL is `http://127.0.0.1:8000/v1`. Override it with
`base_url` for non-default ports or remote endpoints:

```yaml
providers:
  rhel-ai-local:
    engine: rhel-ai
    base_url: "http://192.168.1.100:8080/v1"
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

### OpenShift / corporate route

For RHEL AI served behind an OpenShift route or corporate proxy:

```yaml
providers:
  rhel-ai-openshift:
    engine: rhel-ai
    base_url: "https://rhaii-inference.apps.cluster.example.com/v1"
    api_key_env_var_name: "RHEL_AI_API_KEY"
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

For servers with self-signed or internal CA certificates, set the standard
Node.js environment variable:

```bash
export NODE_EXTRA_CA_CERTS="/path/to/ca-bundle.crt"
```

---

## Model Discovery

Discover which models your RHEL AI server is serving:

```bash
# CLI
aby list-models --discover rhel-ai

# Or with a custom endpoint
curl http://127.0.0.1:8000/v1/models
```

The web dashboard Add Provider wizard also supports model discovery when
you select the `rhel-ai` engine.

---

## Tool Calling

Tool calling support depends on the model being served. Models like
Llama 3.2 Instruct support tool calling; others may not. If the served
model does not support tools, chat will still work but tool calls will
not be executed.

---

## Validation Checklist

Use this checklist when validating a RHEL AI integration:

| # | Scenario | How to test |
|---|----------|-------------|
| 1 | Authentication (no key) | Start server without `--api-key`; omit key fields in config |
| 2 | Authentication (with key) | Start server with `--api-key`; set `RHEL_AI_API_KEY` |
| 3 | Missing key when required | Omit key when server requires it; expect 401 |
| 4 | Model discovery (CLI) | `aby list-models --discover rhel-ai` |
| 5 | Model discovery (web) | Add Provider wizard -> select `rhel-ai` |
| 6 | Chat completions | `aby chat -m rhel-ai-local/<model>` |
| 7 | Streaming (API) | `curl http://localhost:8787/v1/chat/completions` with `"stream": true` |
| 8 | Tool calling | `aby chat` with tools enabled (if model supports it) |
| 9 | VS Code LM API | Configure Provider -> select model -> chat |
| 10 | Models list proxy | `curl http://localhost:8787/v1/models` |

---

## References

- [RHEL AI 3.4 — Getting Started](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux_ai/3.4/html-single/getting_started/getting_started)
- [Red Hat AI Inference — Configuring API key authentication](https://docs.redhat.com/en/documentation/red_hat_ai_inference/3.4/html/getting_started/configuring-api-key-authentication_getting-started)
- [Red Hat AI Inference Server — Technical deep dive](https://www.redhat.com/en/blog/red-hat-ai-inference-server-technical-deep-dive)
- [Abbenay Configuration Guide](CONFIGURATION.md)
