# Running Abbenay in a Container

This guide covers building and running Abbenay as a container image using
the provided `Containerfile`.

---

## Overview

The container packages the Abbenay SEA binary into a minimal UBI 9 image.
The `start` command runs all services:

| Service | Endpoint |
|---------|----------|
| Web dashboard | `http://localhost:8787` |
| REST API | `http://localhost:8787/api/*` |
| OpenAI-compatible API | `http://localhost:8787/v1/chat/completions` |
| MCP server | `http://localhost:8787/mcp` (when `--mcp` is passed) |
| gRPC (TCP) | `localhost:50051` (for Python/programmatic clients) |

### What's different from bare-metal

- **No keytar / keychain.** The container has no D-Bus session or
  gnome-keyring, so `api_key_keychain_name` will not work. Use
  `api_key_env_var_name` in your config and pass keys as environment
  variables.
- **Config is mounted, not baked in.** Bind-mount your `config.yaml`
  into the container at runtime.

---

## Building the image

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
  -p 8787:8787 \
  -p 50051:50051 \
  abbenay:latest
```

With consumer authentication (for programmatic clients like APME):

```bash
podman run -d --name abbenay \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e APME_TOKEN=secret123 \
  -p 8787:8787 \
  -p 50051:50051 \
  abbenay:latest
```

### Verify it's running

```bash
curl http://localhost:8787/api/health
```

### View logs

```bash
podman logs -f abbenay
```

---

## Overriding the command

The default `CMD` is `start --port 8787`, which runs all services. You
can override it to run a subset:

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

# gRPC daemon only (no HTTP port needed)
podman run -d \
  -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
  -e OPENROUTER_API_KEY=sk-or-... \
  abbenay:latest daemon
```

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

When the daemon runs in a container, the Python client connects via TCP
instead of the Unix socket:

```python
from abbenay_grpc import AbbenayClient

# Connect to containerized daemon via TCP
async with AbbenayClient(host="localhost", port=50051) as client:
    async for chunk in client.chat("openrouter/anthropic/claude-sonnet-4", "Hello!"):
        if chunk.text:
            print(chunk.text, end="")
```

The `is_daemon_running()` and `get_daemon_pid()` convenience methods
check the local filesystem and do not apply to remote connections. Use
`health_check()` instead:

```python
client = AbbenayClient(host="container-host", port=50051)
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
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /api/health
              port: 8787
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
- The built-in `HEALTHCHECK` uses `curl` against `/api/health`. In
  Kubernetes, use the `livenessProbe` and `readinessProbe` shown above
  instead.
- Sessions are ephemeral by default. To persist sessions across restarts,
  mount a volume at `/home/abbenay/.local/share/abbenay/sessions/`.
