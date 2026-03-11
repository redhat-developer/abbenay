# Abbenay Python Client

A Python gRPC client for the Abbenay daemon.

## Installation

```bash
pip install abbenay-client
```

## Quick Start

```python
import asyncio
from abbenay_grpc import AbbenayClient

async def main():
    async with AbbenayClient() as client:
        # Chat with a model
        async for chunk in client.chat("openai/gpt-4o", "Hello!"):
            if chunk.type == "text":
                print(chunk.text, end="")
        print()
        
        # List available models
        models = await client.list_models()
        for model in models:
            print(f"- {model.id} ({model.provider})")
        
        # Health check
        healthy = await client.health_check()
        print(f"Daemon healthy: {healthy}")

asyncio.run(main())
```

## Features

- **Chat**: Streaming chat with any configured model
- **Models**: List available models from all providers
- **Providers**: List and check provider status
- **Tools**: Execute MCP tools via high-performance gRPC
- **Secrets**: Manage API keys
- **Configuration**: Get/update daemon config

## Requirements

- Python 3.9+
- Abbenay daemon running (`abbenay daemon`)

## License

MIT
