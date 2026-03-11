# Abbenay Protocol Buffers

This directory contains the gRPC service definition for the Abbenay daemon.

## Structure

```
proto/
└── abbenay/
    └── v1/
        └── service.proto    # Main service definition
```

## Generating Clients

### TypeScript/Node.js (VS Code extension)

The VS Code extension uses `ts-proto` + `nice-grpc`:

```bash
protoc \
  --plugin=./node_modules/.bin/protoc-gen-ts_proto \
  --ts_proto_out=packages/vscode/src/proto \
  --ts_proto_opt=outputServices=nice-grpc,outputServices=generic-definitions,useExactTypes=false \
  -I proto \
  proto/abbenay/v1/service.proto
```

### TypeScript Daemon

The daemon uses `@grpc/proto-loader` for dynamic proto loading (no code generation needed).

### Python

Install grpcio-tools:

```bash
pip install grpcio-tools
```

Generate Python client:

```bash
python -m grpc_tools.protoc \
  -I proto \
  --python_out=packages/python/src/abbenay_grpc \
  --pyi_out=packages/python/src/abbenay_grpc \
  --grpc_python_out=packages/python/src/abbenay_grpc \
  proto/abbenay/v1/service.proto
```

## Service Overview

The `Abbenay` service provides:

- **Chat**: Stateless streaming chat with LLM providers
- **Models & Providers**: List available models and provider status
- **Tools**: List and execute MCP tools
- **Configuration**: Get/update daemon configuration
- **Secrets**: Manage API keys and secrets
- **Lifecycle**: Register/unregister clients, health check, shutdown
- **VS Code Backchannel**: Bidirectional stream for workspace queries
- **Web Server Control**: Start/stop the embedded web dashboard

See `service.proto` for the full API definition.
