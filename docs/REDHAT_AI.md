# Red Hat AI Provider

Abbenay includes a dedicated `redhat` engine for connecting to
[Red Hat AI](https://www.redhat.com/en/technologies/cloud-computing/ai)
inference endpoints. It supports two deployment profiles that both expose
an OpenAI-compatible REST API:

| Profile | Product | Typical endpoint |
|---------|---------|-----------------|
| **Inference Server** | Red Hat AI Inference (vLLM) | `http://127.0.0.1:8000/v1` |
| **MaaS** | Red Hat OpenShift AI Models-as-a-Service | `https://maas.apps.cluster.example.com/v1` |

Both speak the same protocol, so Abbenay routes them through
`@ai-sdk/openai-compatible` — no additional SDK packages are required.

---

## Profile A — Inference Server

Red Hat AI Inference Server is a standalone vLLM instance running locally,
on a RHEL AI host, or in an OpenShift container.

### Quick start

1. **Start the server** — it must serve at least one model at the default
   local endpoint `http://127.0.0.1:8000/v1`:

   ```bash
   curl http://127.0.0.1:8000/v1/models
   ```

2. **Configure Abbenay** (`~/.config/abbenay/config.yaml` on Linux,
   `~/Library/Application Support/abbenay/config.yaml` on macOS):

   ```yaml
   providers:
     redhat-inference:
       engine: redhat
       models:
         RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
   ```

   Replace the model ID with whatever your server's `/v1/models` reports.

3. **Chat**:

   ```bash
   aby start
   aby chat -m redhat-inference/RedHatAI/Llama-3.2-1B-Instruct-FP8
   ```

### Authentication

Inference Server auth is **optional** — it depends on whether the server
was started with the `--api-key` flag.

**No key (default):**

```yaml
providers:
  redhat-inference:
    engine: redhat
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

**With key:**

```yaml
providers:
  redhat-inference:
    engine: redhat
    api_key_env_var_name: "REDHAT_AI_API_KEY"
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

```bash
export REDHAT_AI_API_KEY="your-server-api-key"
```

### Custom base URL

Override the default for non-standard ports, remote hosts, or OpenShift
routes:

```yaml
providers:
  redhat-inference:
    engine: redhat
    base_url: "http://192.168.1.100:8080/v1"
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

For servers with self-signed or internal CA certificates:

```bash
export NODE_EXTRA_CA_CERTS="/path/to/ca-bundle.crt"
```

---

## Profile B — OpenShift AI MaaS

OpenShift AI 3.4 delivers Models-as-a-Service (MaaS): a centrally
governed, self-service AI gateway with token quotas, rate limiting, and
usage tracking. MaaS exposes an OpenAI-compatible `/v1/chat/completions`
endpoint that can route to locally hosted models (vLLM) or external
providers.

### Configuration

MaaS **typically requires** an API key (self-service MaaS keys issued by
the platform):

```yaml
providers:
  redhat-maas:
    engine: redhat
    base_url: "https://maas.apps.cluster.example.com/v1"
    api_key_env_var_name: "REDHAT_AI_API_KEY"
    models:
      llama-3.1-8b-instruct: {}
```

```bash
export REDHAT_AI_API_KEY="your-maas-api-key"
```

### Key differences from Inference Server

| Aspect | Inference Server | MaaS |
|--------|-----------------|------|
| Auth | Optional (`--api-key`) | Typically required (self-service keys) |
| Base URL | `http://127.0.0.1:8000/v1` | Cluster route, e.g. `https://maas.apps.…/v1` |
| Governance | None (bare metal) | Token quotas, rate limiting, showback |
| Model routing | Single model | Gateway can route to multiple backends |

---

## Model Discovery

```bash
aby list-models --discover redhat

# Or directly:
curl http://127.0.0.1:8000/v1/models
```

The web dashboard Add Provider wizard also supports model discovery when
you select the `redhat` engine.

---

## Tool Calling

Tool calling support depends on the model being served. Models like
Llama 3.2 Instruct support tool calling; others may not. If the served
model does not support tools, chat will still work but tool calls will
not be executed.

---

## Container Usage

When running Abbenay inside a container and the Inference Server is on
the host:

```yaml
providers:
  redhat-inference:
    engine: redhat
    base_url: "http://host.containers.internal:8000/v1"
    models:
      RedHatAI/Llama-3.2-1B-Instruct-FP8: {}
```

---

## Validation Checklist

| # | Scenario | How to test |
|---|----------|-------------|
| 1 | Auth (no key) | Start server without `--api-key`; omit key fields |
| 2 | Auth (with key) | Start server with `--api-key`; set `REDHAT_AI_API_KEY` |
| 3 | Missing key | Omit key when server requires it; expect 401 |
| 4 | MaaS endpoint | Set `base_url` to MaaS route; provide API key |
| 5 | Model discovery (CLI) | `aby list-models --discover redhat` |
| 6 | Model discovery (web) | Add Provider wizard → select `redhat` |
| 7 | Chat completions | `aby chat -m redhat-inference/<model>` |
| 8 | Streaming | `curl http://localhost:8787/v1/chat/completions` with `"stream": true` |
| 9 | Tool calling | `aby chat` with tools enabled (if model supports it) |
| 10 | VS Code LM API | Configure Provider → select model → chat |

---

## References

- [Red Hat AI 3.4 — From inference to agents](https://www.redhat.com/en/blog/inference-agentic-ai-scaling-enterprise-foundation-red-hat-ai-34)
- [Scaling enterprise AI: MaaS with OpenShift AI 3.4](https://www.redhat.com/en/blog/scaling-enterprise-ai-delivering-models-service-openshift-ai-34)
- [Red Hat AI Inference — Configuring API key authentication](https://docs.redhat.com/en/documentation/red_hat_ai_inference/3.4/html/getting_started/configuring-api-key-authentication_getting-started)
- [RHEL AI 3.4 — Getting Started](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux_ai/3.4/html-single/getting_started/getting_started)
- [Abbenay Configuration Guide](CONFIGURATION.md)
