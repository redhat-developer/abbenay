"""Abbenay gRPC Client for Python.

This module provides a Python client for communicating with the Abbenay daemon
via gRPC over Unix Domain Sockets.

Daemon paths:
    Socket: $XDG_RUNTIME_DIR/abbenay/daemon.sock (or ~/.abbenay/daemon.sock)
    PID file: $XDG_RUNTIME_DIR/abbenay/abbenay.pid (or ~/.abbenay/abbenay.pid)

Example usage:

    from abbenay_grpc import AbbenayClient

    # Check if daemon is running
    if not AbbenayClient.is_daemon_running():
        print("Start the daemon: abbenay daemon")
    
    async with AbbenayClient() as client:
        # Chat with a model
        async for chunk in client.chat("openai/gpt-4o", "Hello!"):
            print(chunk.text, end="")
        
        # Create a session
        session = await client.create_session("openai/gpt-4o")
        
        # List sessions
        sessions = await client.list_sessions()
        for s in sessions:
            print(f"{s.id}: {s.topic}")
"""

from .client import (
    AbbenayClient,
    AbbenayError,
    ConnectionError,
    NotFoundError,
    ChatChunk,
    Session,
    Model,
)

__all__ = [
    "AbbenayClient",
    "AbbenayError",
    "ConnectionError",
    "NotFoundError",
    "ChatChunk",
    "Session",
    "Model",
]
__version__ = "0.1.0"
