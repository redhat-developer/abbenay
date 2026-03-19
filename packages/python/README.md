# Abbenay Python Client

A Python gRPC client for the Abbenay daemon.

## Installation

```bash
pip install abbenay-client
```

> **Note:** The pip package is `abbenay-client` but the Python import is
> `abbenay_grpc`:
>
> ```python
> from abbenay_grpc import AbbenayClient
> ```

## Quick Start

```python
import asyncio
from abbenay_grpc import AbbenayClient

async def main():
    async with AbbenayClient() as client:
        async for chunk in client.chat("openai/gpt-4o", "Hello!"):
            if chunk.type == "text":
                print(chunk.text, end="")
        print()

asyncio.run(main())
```

## Event Loop Lifecycle

`grpc.aio` channels are bound to the event loop that was active at
`connect()` time.  If you call `asyncio.run()` more than once (which
creates and destroys loops), call `reconnect()` in the new loop:

```python
async def preflight():
    async with AbbenayClient() as client:
        await client.health_check()

asyncio.run(preflight())  # loop created and closed

async def main():
    client = AbbenayClient()
    await client.connect()  # auto-detects dead channel, reconnects
    # ... or explicitly: await client.reconnect()
```

## Connecting to a Container

When the daemon runs in a container, connect via TCP instead of the
default Unix socket:

```python
async with AbbenayClient(host="localhost", port=50051) as client:
    async for chunk in client.chat("openrouter/anthropic/claude-sonnet-4", "Hello!"):
        if chunk.text:
            print(chunk.text, end="")
```

The container must be started with `--grpc-port 50051` (the default
`Containerfile` CMD does this) and the port published (`-p 50051:50051`).

See [docs/CONTAINER.md](../../docs/CONTAINER.md) for full container
deployment instructions.

## Features

- **Chat**: Streaming chat with any configured model
- **Sessions**: Create, list, fork, and manage chat sessions
- **Models**: List available models from all providers
- **Tools**: Dynamic MCP server registration and tool filtering
- **Secrets**: Manage API keys via keychain
- **Configuration**: Get/update daemon config

## Requirements

- Python 3.9+
- Abbenay daemon running (`abbenay daemon`)

## License

MIT
