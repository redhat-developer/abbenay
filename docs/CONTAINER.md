# Running Abbenay in a Container

This guide covers building and running Abbenay as a container image using
the provided `Containerfile`.

---

## Pre-built images from GHCR

Multi-arch images (linux/amd64 and linux/arm64) are published
automatically to the GitHub Container Registry on every merge to `main`
and on every release tag.

```bash
# Latest stable release
podman pull ghcr.io/redhat-developer/abbenay:latest

# Latest from main (development builds)
podman pull ghcr.io/redhat-developer/abbenay:main

# Specific release
podman pull ghcr.io/redhat-developer/abbenay:v1.0.0
```

Then run it the same way as a locally built image (see [Running](#running)
below).

---

## Overview

The container packages the Abbenay SEA binary into a minimal UBI 9 image.
The `start` command runs all services:

| Service | Endpoint |
|---------|----------|
| Web dashboard | `http://localhost:8787` |
| REST API | `http://localhost:8787/api/*` |
| OpenAI-compatible API | `http://localhost:8787/v1/chat/completions` |
| MCP server | `http://localhost:8787/mcp` (when `--mcp` is passed; requires Bearer auth; tools honor `tool_policy`) |
| gRPC (TCP) | `localhost:50051` (for Python/programmatic clients) |

### What's different from bare-metal

- **No keytar / keychain.** The container has no D-Bus session or
  gnome-keyring, so `api_key_keychain_name` will not work. Use
  `api_key_env_var_name` in your config and pass keys as environment
  variables.
- **Config is mounted, not baked in.** Bind-mount your `config.yaml`
  into the container at runtime.

---

## Building the image locally

If you prefer to build from source instead of pulling from GHCR:

```bash
podman build -f Containerfile -t abbenay:latest .
```

The multi-stage build compiles the SEA binary in a Node.js builder stage
and copies only the binary and its sidecars (`proto/`, `static/`) into a
UBI 9 minimal runtime image. The final image contains no Node.js, npm,
or build tooling.

---

## Configuration

Create a `config.yaml` that uses `api_key_env_var_name` instead of
`api_key_keychain_name`. A ready-to-use example is provided at
[`config.container.example.yaml`](../config.container.example.yaml)
in the repo root.

Minimal example:

```yaml
providers:
  openrouter:
    engine: openrouter
    api_key_env_var_name: "OPENROUTER_API_KEY"
    models:
      anthropic/claude-sonnet-4: {}
      anthropic/claude-haiku-3.5: {}
```

Mount this file into the container at:

```
/home/abbenay/.config/abbenay/config.yaml
```

---

## Running

```bash
podman run -d --name abbenay \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e ABBENAY_API_TOKEN=change-me \
  -p 8787:8787 \
  -p 50051:50051 \
  abbenay:latest
```

Consumer authentication is **required** for the default image CMD (`--grpc-host
0.0.0.0`). Use `config.container.example.yaml` (includes a `consumers` section)
and pass the consumer token env:

```bash
podman run -d --name abbenay \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e ABBENAY_API_TOKEN=change-me \
  -e APME_TOKEN=secret123 \
  -p 8787:8787 \
  -p 50051:50051 \
  abbenay:latest
```

Without a `consumers` section the daemon refuses to start on `0.0.0.0` unless
you pass `--allow-open-auth` or `--insecure` (not recommended).

### Verify it's running

```bash
curl -H "Authorization: Bearer $ABBENAY_API_TOKEN" http://127.0.0.1:8787/api/health
```

Set `ABBENAY_API_TOKEN` in the container environment (required for the
built-in healthcheck and all HTTP routes).

### View logs

```bash
podman logs -f abbenay
```

---

## Overriding the command

The default `CMD` is
`start --port 8787 --host 0.0.0.0 --grpc-port 50051 --grpc-host 0.0.0.0 --grpc-tls`,
which runs all services with HTTP and TLS-protected gRPC accessible from outside the
container. You can override it to run a subset:

```bash
# Web dashboard and REST API only
podman run -d -p 8787:8787 \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  abbenay:latest web --port 8787

# OpenAI-compatible API only
podman run -d -p 8787:8787 \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  abbenay:latest serve --port 8787

# gRPC daemon only (TLS required for 0.0.0.0)
podman run -d -p 50051:50051 \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  abbenay:latest daemon --grpc-port 50051 --grpc-host 0.0.0.0 --grpc-tls
```

> Binding to `0.0.0.0` without `--grpc-tls` and without
> `--insecure` is refused at startup.

---

## Multiple providers

Pass one environment variable per provider key:

```bash
podman run -d --name abbenay \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e OPENAI_API_KEY=sk-... \
  -p 8787:8787 \
  abbenay:latest
```

Your `config.yaml` references these by name:

```yaml
providers:
  openrouter:
    engine: openrouter
    api_key_env_var_name: "OPENROUTER_API_KEY"
    models: { ... }
  anthropic:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    models: { ... }
  openai:
    engine: openai
    api_key_env_var_name: "OPENAI_API_KEY"
    models: { ... }
```

---

## Python gRPC client

When the daemon runs in a container with `--grpc-tls` (the default image CMD),
the Python client must trust the daemon CA:

```python
from abbenay_grpc import AbbenayClient

# Copy ca.crt out of the container (runtime tls/ dir) or mount it, then:
async with AbbenayClient(
    host="localhost",
    port=50051,
    tls=True,
    ca_cert="/path/to/ca.crt",
) as client:
    async for chunk in client.chat("openrouter/anthropic/claude-sonnet-4", "Hello!"):
        if chunk.text:
            print(chunk.text, end="")
```

If you intentionally start the container with `--insecure` instead of
`--grpc-tls`, omit `tls` / `ca_cert` (plaintext TCP — not recommended).

The `is_daemon_running()` and `get_daemon_pid()` convenience methods
check the local filesystem and do not apply to remote connections. Use
`health_check()` instead:

```python
client = AbbenayClient(host="container-host", port=50051, tls=True, ca_cert="/path/to/ca.crt")
await client.connect()
healthy = await client.health_check()
```

---

## Kubernetes / OpenShift

### Deployment with mounted Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: abbenay-keys
type: Opaque
stringData:
  OPENROUTER_API_KEY: "sk-or-..."
  # Must match the Bearer value in the probe httpHeaders below.
  # Kubernetes does not expand env vars in httpGet.httpHeaders.
  ABBENAY_API_TOKEN: "replace-with-a-strong-token"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: abbenay-config
data:
  config.yaml: |
    providers:
      openrouter:
        engine: openrouter
        api_key_env_var_name: "OPENROUTER_API_KEY"
        models:
          anthropic/claude-sonnet-4: {}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: abbenay
spec:
  replicas: 1
  selector:
    matchLabels:
      app: abbenay
  template:
    metadata:
      labels:
        app: abbenay
    spec:
      containers:
        - name: abbenay
          image: abbenay:latest
          ports:
            - containerPort: 8787
              name: http
            - containerPort: 50051
              name: grpc
          envFrom:
            - secretRef:
                name: abbenay-keys
          volumeMounts:
            - name: config
              mountPath: /home/abbenay/.config/abbenay/config.yaml
              subPath: config.yaml
              readOnly: true
          livenessProbe:
            httpGet:
              path: /api/health
              port: 8787
              httpHeaders:
                - name: Authorization
                  value: Bearer replace-with-a-strong-token
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /api/health
              port: 8787
              httpHeaders:
                - name: Authorization
                  value: Bearer replace-with-a-strong-token
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: config
          configMap:
            name: abbenay-config
---
apiVersion: v1
kind: Service
metadata:
  name: abbenay
spec:
  selector:
    app: abbenay
  ports:
    - name: http
      port: 8787
      targetPort: 8787
    - name: grpc
      port: 50051
      targetPort: 50051
```

### Notes

- The image runs as non-root user `abbenay` (UID 1001), compatible with
  OpenShift's restricted SCC.
- The built-in `HEALTHCHECK` uses `curl` against `/api/health` with
  `Authorization: Bearer ${ABBENAY_API_TOKEN}`. Set that env var when
  running the container. In Kubernetes, the sample `livenessProbe` /
  `readinessProbe` send the same Bearer token via `httpHeaders` — keep that
  value identical to `ABBENAY_API_TOKEN` in the Secret (Kubernetes does not
  expand environment variables in `httpGet.httpHeaders`).
- Sessions are ephemeral by default. To persist sessions across restarts,
  mount a volume at `/home/abbenay/.local/share/abbenay/sessions/`.

---

## Security: HTTP bind and authentication

> Workstation CLI defaults bind HTTP to `127.0.0.1` with auth on. The
> **container image CMD** intentionally uses `--host 0.0.0.0` so published
> ports work — that is opt-in exposure, not “air-gap security.” See
> [SECURITY.md](./SECURITY.md).

| Flag | Default | Effect |
|------|---------|--------|
| `--host` / `ABBENAY_HTTP_HOST` / `server.host` | `127.0.0.1` | HTTP bind (dashboard, `/api/*`, `/v1/*`, `/mcp`) |

| Value | Effect |
|-------|--------|
| `127.0.0.1` (default) | Loopback only — safe for local development |
| `0.0.0.0` | All interfaces — required inside containers so published ports are reachable |

The container's default `CMD` uses `--host 0.0.0.0` because container
networking requires listeners to accept connections from outside the
container's network namespace. The daemon logs a warning when HTTP is bound
beyond loopback.

**HTTP authentication is on by default.** Set `ABBENAY_API_TOKEN` (or
`server.api_token` / `server.api_token_env`) and pass
`Authorization: Bearer <token>` on every request. CORS is allowlist-only
(never `*`).

> **WARNING:** `ABBENAY_HTTP_AUTH=0` disables HTTP auth on any bind, including
> the container default `--host 0.0.0.0`. The server starts and logs a loud
> warning; any client that can reach the published port has full API access.

Typical production shapes that use auth-off intentionally. Abbenay does **not**
validate proxy headers or mesh identity when auth is off — the security
boundary is network isolation (who can open a TCP connection to the pod).

**Cluster-internal Service** — other pods call Abbenay on the private network;
no public Ingress/NodePort/LoadBalancer to `:8787`:

```yaml
# Deployment env (CMD already binds --host 0.0.0.0)
env:
  - name: ABBENAY_HTTP_AUTH
    value: "0"
---
# Service: ClusterIP only (not NodePort / LoadBalancer)
apiVersion: v1
kind: Service
metadata:
  name: abbenay
spec:
  type: ClusterIP
  selector:
    app: abbenay
  ports:
    - port: 8787
      targetPort: 8787
---
# Optional: deny ingress except from the caller namespace (name = ai-clients).
# kubernetes.io/metadata.name is set automatically on the Namespace object.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: abbenay-internal-only
spec:
  podSelector:
    matchLabels:
      app: abbenay
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ai-clients
      ports:
        - protocol: TCP
          port: 8787
```

**Auth at the proxy** — oauth2-proxy (or an API gateway / ingress auth) is the
only path to Abbenay; the Abbenay Service stays ClusterIP and is not published
publicly. Abbenay trusts the private hop:

```yaml
# Abbenay Deployment
env:
  - name: ABBENAY_HTTP_AUTH
    value: "0"
# oauth2-proxy (sketch): upstream = http://abbenay:8787
# Ingress routes / → oauth2-proxy only; do not Ingress Abbenay directly.
```

When Abbenay itself must authenticate callers, keep `ABBENAY_HTTP_AUTH`
enabled (the default), set a strong `ABBENAY_API_TOKEN`, and restrict
`server.cors_origins`.

## Security: gRPC bind, TLS, and `--insecure`

The `--grpc-host` flag controls which network interface the TCP gRPC
listener binds to. Non-loopback binds fail closed unless TLS is enabled
or `--insecure` is set explicitly.

| Value | Effect |
|-------|--------|
| `127.0.0.1` (default) | Loopback only — plaintext allowed for local development |
| `0.0.0.0` / non-loopback | Requires `--grpc-tls` **or** `--insecure` |

### Flags

| Flag | Purpose |
|------|---------|
| `--grpc-tls` | Enable TLS; auto-generates self-signed certs |
| `--insecure` | Allow plaintext on non-loopback binds (escape hatch; not recommended) |

### Auto-generated certificates

With `--grpc-tls`, the daemon writes:

- `<runtime-dir>/tls/server.crt`
- `<runtime-dir>/tls/server.key` (mode 0600)
- `<runtime-dir>/tls/ca.crt` (same as server cert — trust anchor for clients)

The certificate CN / default SSL target name is `abbenay-grpc`. Clients must
trust `ca.crt` (and typically override the SSL target name to `abbenay-grpc`
when connecting by IP).

### Client trust

- **Python:** `AbbenayClient(host=..., tls=True, ca_cert=".../ca.crt")`
- **grpc-web-control:** pass `tls: true` and `caPath` for TCP targets
- **Unix socket:** remains plaintext local IPC (no TLS required)

### Insecure tradeoffs

`--insecure` on `0.0.0.0` restores the old plaintext behavior. API keys, chat,
provider config, and tools travel unencrypted. Prefer `--grpc-tls`.

**Consumers (DR-037):** Non-loopback gRPC binds refuse to start when
`consumers` is missing/empty unless `--allow-open-auth` or `--insecure` is
set. The image default CMD uses `--grpc-tls` on `0.0.0.0`, so mount a config
with a `consumers` section (see `config.container.example.yaml`) and pass the
token env (e.g. `-e APME_TOKEN=...`). Clients send the token as gRPC metadata
`x-abbenay-token`. See
[CONFIGURATION.md](./CONFIGURATION.md#consumer-authentication-consumers).
