"""Abbenay gRPC Client implementation."""

from __future__ import annotations

import os
import asyncio
from pathlib import Path
from typing import AsyncIterator, Optional, List, Dict, Any, Union
from dataclasses import dataclass

import grpc

try:
    from .abbenay.v1 import service_pb2 as proto
    from .abbenay.v1 import service_pb2_grpc as grpc_service
except ImportError as _import_err:
    import warnings as _warnings
    _warnings.warn(
        f"Failed to import gRPC stubs: {_import_err}. "
        f"Regenerate with: npm run build -- --proto-only"
    )
    proto = None  # type: ignore[assignment]
    grpc_service = None


def _to_policy_proto(policy: Union["proto.PolicyConfig", Dict[str, Any]]) -> "proto.PolicyConfig":
    """Convert a dict or PolicyConfig proto to a PolicyConfig proto message."""
    if isinstance(policy, dict):
        from google.protobuf.json_format import ParseDict
        return ParseDict(policy, proto.PolicyConfig())
    if proto is not None and isinstance(policy, proto.PolicyConfig):
        return policy
    raise TypeError(
        f"policy must be a dict or PolicyConfig proto, got {type(policy).__name__}"
    )


class AbbenayError(Exception):
    """Base exception for Abbenay client errors."""
    pass


class ConnectionError(AbbenayError):
    """Failed to connect to daemon."""
    pass


class NotFoundError(AbbenayError):
    """Requested resource not found."""
    pass


@dataclass
class ChatChunk:
    """A chunk of chat response."""
    type: str  # "text", "tool_call", "tool_result", "done"
    text: Optional[str] = None
    tool_name: Optional[str] = None
    tool_args: Optional[str] = None
    tool_result: Optional[str] = None
    finish_reason: Optional[str] = None


@dataclass
class Session:
    """A chat session."""
    id: str
    model: str
    topic: Optional[str]
    message_count: int
    source: str
    created_at: str
    updated_at: str


@dataclass
class Model:
    """An available model."""
    id: str
    provider: str
    name: str
    supports_streaming: bool
    supports_tools: bool


class AbbenayClient:
    """Client for the Abbenay daemon.
    
    Example:
        async with AbbenayClient() as client:
            async for chunk in client.chat("openai/gpt-4o", "Hello!"):
                print(chunk.text, end="")
    """
    
    def __init__(
        self,
        socket_path: Optional[str] = None,
        host: Optional[str] = None,
        port: int = 50051,
    ):
        """Initialize the client.
        
        Args:
            socket_path: Path to Unix socket (default: ~/.abbenay/daemon.sock)
            host: TCP host (if using TCP instead of Unix socket)
            port: TCP port (default: 50051)
        """
        if socket_path:
            self._target = f"unix://{socket_path}"
        elif host:
            self._target = f"{host}:{port}"
        else:
            # Default to Unix socket
            default_socket = self._default_socket_path()
            self._target = f"unix://{default_socket}"
        
        self._channel: Optional[grpc.aio.Channel] = None
        self._stub = None
        self._client_id: Optional[str] = None
    
    @staticmethod
    def _get_abbenay_dir() -> Path:
        """Get the Abbenay runtime directory.
        
        Uses XDG_RUNTIME_DIR if available (Linux standard), otherwise ~/.abbenay/
        """
        xdg_runtime = os.environ.get("XDG_RUNTIME_DIR")
        if xdg_runtime:
            return Path(xdg_runtime) / "abbenay"
        return Path.home() / ".abbenay"
    
    @classmethod
    def _default_socket_path(cls) -> str:
        """Get the default socket path."""
        return str(cls._get_abbenay_dir() / "daemon.sock")
    
    @classmethod
    def _pid_file_path(cls) -> str:
        """Get the PID file path."""
        return str(cls._get_abbenay_dir() / "abbenay.pid")
    
    @classmethod
    def is_daemon_running(cls) -> bool:
        """Check if the daemon is running.
        
        Verifies PID file exists and process is alive.
        """
        pid_file = Path(cls._pid_file_path())
        socket_file = Path(cls._default_socket_path())
        
        if not pid_file.exists():
            return False
        
        try:
            pid = int(pid_file.read_text().strip())
            # Signal 0 checks if process exists
            os.kill(pid, 0)
            return socket_file.exists()
        except (ValueError, ProcessLookupError, PermissionError):
            return False
    
    @classmethod
    def get_daemon_pid(cls) -> Optional[int]:
        """Get the daemon PID if running."""
        pid_file = Path(cls._pid_file_path())
        
        if not pid_file.exists():
            return None
        
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 0)  # Check if alive
            return pid
        except (ValueError, ProcessLookupError, PermissionError):
            return None
    
    async def __aenter__(self) -> "AbbenayClient":
        """Connect to the daemon."""
        await self.connect()
        return self
    
    async def __aexit__(self, *args) -> None:
        """Disconnect from the daemon."""
        await self.disconnect()
    
    async def connect(self) -> None:
        """Connect to the daemon and register as a client.

        Safe to call multiple times — if the channel is already connected
        and healthy, this is a no-op.  If the channel is dead (e.g. the
        event loop was recycled via ``asyncio.run()``), it is silently
        replaced with a fresh one.
        """
        if grpc_service is None:
            raise AbbenayError(
                "gRPC stubs failed to import (check warnings at startup). "
                "Regenerate with: npm run build -- --proto-only"
            )

        if self._channel is not None:
            try:
                state = self._channel.get_state(try_to_connect=False)
                if state != grpc.ChannelConnectivity.SHUTDOWN:
                    return
            except Exception:
                pass
            # Channel is dead — tear it down before reconnecting
            self._channel = None
            self._stub = None
            self._client_id = None

        try:
            self._channel = grpc.aio.insecure_channel(self._target)
            self._stub = grpc_service.AbbenayStub(self._channel)
            
            response = await self._stub.Register(
                proto.RegisterRequest(
                    client=proto.ClientInfo(
                        client_type=proto.CLIENT_TYPE_PYTHON,
                    ),
                    is_spawner=False,
                )
            )
            self._client_id = response.client_id
            
        except grpc.aio.AioRpcError as e:
            raise ConnectionError(f"Failed to connect to daemon: {e}") from e

    async def reconnect(self) -> None:
        """Discard the current channel and establish a fresh connection.

        Use this when crossing event-loop boundaries (e.g. after
        ``asyncio.run()`` closes and re-creates the loop).
        """
        if self._channel is not None:
            try:
                await self._channel.close()
            except Exception:
                pass
            self._channel = None
            self._stub = None
            self._client_id = None
        await self.connect()
    
    async def disconnect(self) -> None:
        """Disconnect from the daemon."""
        if self._stub and self._client_id:
            try:
                await self._stub.Unregister(
                    proto.UnregisterRequest(client_id=self._client_id)
                )
            except grpc.aio.AioRpcError:
                pass
        
        if self._channel:
            try:
                await self._channel.close()
            except Exception:
                pass
            self._channel = None
            self._stub = None
            self._client_id = None
    
    async def chat(
        self,
        model: str,
        message: str,
        *,
        system: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        enable_tools: bool = False,
        policy: Optional[Union["proto.PolicyConfig", Dict[str, Any]]] = None,
        token: Optional[str] = None,
    ) -> AsyncIterator[ChatChunk]:
        """Chat with a model.
        
        Args:
            model: Model ID (e.g., "openai/gpt-4o")
            message: User message
            system: Optional system prompt
            temperature: Optional temperature (0-2)
            max_tokens: Optional max tokens
            enable_tools: Enable tool calling
            policy: Optional inline policy override. Accepts either a
                PolicyConfig proto message or a plain dict matching the
                proto structure (e.g., {"sampling": {"temperature": 0.0}}).
                When set, fully replaces any named policy on the model.
            token: Optional consumer auth token for inline policy
                authorization (sent as x-abbenay-token gRPC metadata).
                Required when the server has a ``consumers`` section in
                config and the consumer needs the ``inline_policy``
                capability.
            
        Yields:
            ChatChunk objects containing response data
            
        Raises:
            AbbenayError: If the server streams an error chunk (e.g.,
                INVALID_ARGUMENT for a malformed inline policy, or
                PERMISSION_DENIED when consumer auth fails).
        """
        self._ensure_connected()
        
        messages = []
        if system:
            messages.append(proto.Message(
                role=proto.ROLE_SYSTEM,
                content=system,
            ))
        messages.append(proto.Message(
            role=proto.ROLE_USER,
            content=message,
        ))
        
        options = proto.ChatOptions(
            enable_tools=enable_tools,
        )
        if temperature is not None:
            options.temperature = temperature
        if max_tokens is not None:
            options.max_tokens = max_tokens
        
        request = proto.ChatRequest(
            model=model,
            messages=messages,
            options=options,
        )
        
        if policy is not None:
            request.policy.CopyFrom(_to_policy_proto(policy))
        
        metadata = []
        if token is not None:
            metadata.append(("x-abbenay-token", token))
        
        async for chunk in self._stub.Chat(request, metadata=metadata or None):
            yield self._parse_chunk(chunk)
    
    async def create_session(
        self,
        model: str,
        topic: Optional[str] = None,
        metadata: Optional[Dict[str, str]] = None,
    ) -> Session:
        """Create a new chat session.
        
        Args:
            model: Model ID
            topic: Optional topic/title
            metadata: Optional metadata
            
        Returns:
            The created Session
        """
        self._ensure_connected()
        
        request = proto.CreateSessionRequest(
            model=model,
            topic=topic or "",
            metadata=metadata or {},
        )
        
        response = await self._stub.CreateSession(request)
        return self._parse_session(response)
    
    async def get_session(self, session_id: str) -> Session:
        """Get a session by ID.
        
        Args:
            session_id: Session ID
            
        Returns:
            The Session
            
        Raises:
            NotFoundError: If session doesn't exist
        """
        self._ensure_connected()
        
        try:
            response = await self._stub.GetSession(
                proto.GetSessionRequest(
                    session_id=session_id,
                    include_messages=True,
                )
            )
            return self._parse_session(response)
        except grpc.aio.AioRpcError as e:
            if e.code() == grpc.StatusCode.NOT_FOUND:
                raise NotFoundError(f"Session {session_id} not found") from e
            raise
    
    async def list_sessions(
        self,
        limit: int = 10,
        offset: int = 0,
    ) -> List[Session]:
        """List all sessions.
        
        Args:
            limit: Max sessions to return
            offset: Pagination offset
            
        Returns:
            List of Sessions
        """
        self._ensure_connected()
        
        response = await self._stub.ListSessions(
            proto.ListSessionsRequest(
                limit=limit,
                offset=offset,
            )
        )
        
        return [
            Session(
                id=s.id,
                model=s.model,
                topic=s.topic or None,
                message_count=s.message_count,
                source=proto.ClientType.Name(s.source).lower().replace("client_type_", ""),
                created_at=str(s.created_at),
                updated_at=str(s.updated_at),
            )
            for s in response.sessions
        ]
    
    async def delete_session(self, session_id: str) -> None:
        """Delete a session.
        
        Args:
            session_id: Session ID
        """
        self._ensure_connected()
        
        try:
            await self._stub.DeleteSession(
                proto.DeleteSessionRequest(session_id=session_id)
            )
        except grpc.aio.AioRpcError as e:
            if e.code() == grpc.StatusCode.NOT_FOUND:
                raise NotFoundError(f"Session {session_id} not found") from e
            raise
    
    async def export_session(self, session_id: str) -> str:
        """Export a session as JSON.
        
        Args:
            session_id: Session ID
            
        Returns:
            JSON string
        """
        self._ensure_connected()
        
        response = await self._stub.ExportSession(
            proto.ExportSessionRequest(
                session_id=session_id,
                include_tool_results=True,
                include_metadata=True,
            )
        )
        return response.json_content
    
    async def import_session(
        self,
        json_content: str,
        generate_new_id: bool = False,
    ) -> Session:
        """Import a session from JSON.
        
        Args:
            json_content: JSON string
            generate_new_id: Generate new ID instead of using imported
            
        Returns:
            The imported Session
        """
        self._ensure_connected()
        
        response = await self._stub.ImportSession(
            proto.ImportSessionRequest(
                json_content=json_content,
                generate_new_id=generate_new_id,
            )
        )
        return self._parse_session(response)
    
    async def session_chat(
        self,
        session_id: str,
        message: str,
        *,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        enable_tools: bool = False,
        tool_filter: Optional[List[str]] = None,
        policy: Optional[Union["proto.PolicyConfig", Dict[str, Any]]] = None,
        token: Optional[str] = None,
    ) -> AsyncIterator[ChatChunk]:
        """Chat within an existing session.

        Args:
            session_id: Session ID to chat within
            message: User message
            temperature: Optional temperature (0-2)
            max_tokens: Optional max tokens
            enable_tools: Enable tool calling
            tool_filter: Only expose these tools to the LLM (empty = all)
            policy: Optional inline policy override
            token: Optional consumer auth token

        Yields:
            ChatChunk objects containing response data

        Raises:
            AbbenayError: On server error chunks
        """
        self._ensure_connected()

        options = proto.ChatOptions(
            enable_tools=enable_tools,
            tool_mode="auto" if enable_tools else "none",
        )
        if temperature is not None:
            options.temperature = temperature
        if max_tokens is not None:
            options.max_tokens = max_tokens
        if tool_filter:
            options.tool_filter.extend(tool_filter)

        request = proto.SessionChatRequest(
            session_id=session_id,
            message=proto.Message(
                role=proto.ROLE_USER,
                content=message,
            ),
            options=options,
        )

        if policy is not None:
            request.policy.CopyFrom(_to_policy_proto(policy))

        metadata = []
        if token is not None:
            metadata.append(("x-abbenay-token", token))

        async for chunk in self._stub.SessionChat(request, metadata=metadata or None):
            yield self._parse_chunk(chunk)

    async def register_mcp_server(
        self,
        server_id: str,
        transport: Dict[str, Any],
        *,
        session_id: Optional[str] = None,
        tool_filter: Optional[List[str]] = None,
        token: Optional[str] = None,
    ) -> List[str]:
        """Register a dynamic MCP server.

        The caller is responsible for starting and owning the MCP server
        lifecycle. Abbenay connects as an MCP client to the provided
        endpoint.

        Args:
            server_id: Unique server identifier (e.g., "apme-ansible-doc")
            transport: Transport config dict with keys:
                type: "http" | "sse" | "stdio"
                url: endpoint URL (http/sse)
                command: command to run (stdio)
                args: command arguments (stdio)
            session_id: Scope to a session (auto-cleanup on delete)
            tool_filter: Only register these tools from the server
            token: Consumer auth token for mcp_register capability

        Returns:
            List of discovered tool names (namespaced)

        Raises:
            AbbenayError: On registration failure
        """
        self._ensure_connected()

        mcp_transport = proto.McpTransport(
            type=transport.get("type", "http"),
        )
        if "url" in transport:
            mcp_transport.url = transport["url"]
        if "command" in transport:
            mcp_transport.command = transport["command"]
        if "args" in transport:
            mcp_transport.args.extend(transport["args"])
        if "headers" in transport:
            for k, v in transport["headers"].items():
                mcp_transport.headers[k] = v

        request = proto.RegisterMcpServerRequest(
            server_id=server_id,
            transport=mcp_transport,
        )
        if session_id is not None:
            request.session_id = session_id
        if tool_filter:
            request.tool_filter.extend(tool_filter)

        metadata = []
        if token is not None:
            metadata.append(("x-abbenay-token", token))
        if self._client_id is not None:
            metadata.append(("x-abbenay-client-id", self._client_id))

        try:
            response = await self._stub.RegisterMcpServer(
                request, metadata=metadata or None,
            )
            return list(response.discovered_tools)
        except grpc.aio.AioRpcError as e:
            raise AbbenayError(
                f"Failed to register MCP server '{server_id}': {e.details()}"
            ) from e

    async def unregister_mcp_server(
        self,
        server_id: str,
        *,
        token: Optional[str] = None,
    ) -> bool:
        """Unregister a dynamically registered MCP server.

        Args:
            server_id: Server ID to unregister
            token: Consumer auth token

        Returns:
            True if successfully unregistered
        """
        self._ensure_connected()

        metadata = []
        if token is not None:
            metadata.append(("x-abbenay-token", token))

        try:
            response = await self._stub.UnregisterMcpServer(
                proto.UnregisterMcpServerRequest(server_id=server_id),
                metadata=metadata or None,
            )
            return response.success
        except grpc.aio.AioRpcError as e:
            raise AbbenayError(
                f"Failed to unregister MCP server '{server_id}': {e.details()}"
            ) from e

    async def list_models(self) -> List[Model]:
        """List available models.
        
        Returns:
            List of Models
        """
        self._ensure_connected()
        
        response = await self._stub.ListModels(proto.ListModelsRequest())
        
        return [
            Model(
                id=m.id,
                provider=m.provider,
                name=m.name,
                supports_streaming=m.capabilities.supports_streaming,
                supports_tools=m.capabilities.supports_tools,
            )
            for m in response.models
        ]
    
    async def health_check(self) -> bool:
        """Check if daemon is healthy.
        
        Returns:
            True if healthy
        """
        self._ensure_connected()
        
        response = await self._stub.HealthCheck(proto.HealthCheckRequest())
        return response.healthy
    
    async def get_status(self) -> Dict[str, Any]:
        """Get daemon status.
        
        Returns:
            Status dictionary
        """
        self._ensure_connected()
        
        response = await self._stub.GetStatus(proto.GetStatusRequest())
        
        return {
            "version": response.version,
            "started_at": str(response.started_at),
            "connected_clients": response.connected_clients,
            "active_sessions": response.active_sessions,
            "mcp_servers": list(response.registered_mcp_servers),
        }
    
    def _ensure_connected(self) -> None:
        """Ensure we're connected to the daemon."""
        if self._stub is None:
            raise AbbenayError("Not connected. Use 'async with AbbenayClient()' or call connect()")
    
    def _parse_chunk(self, chunk) -> ChatChunk:
        """Parse a proto ChatChunk into our ChatChunk."""
        which = chunk.WhichOneof("chunk")
        
        if which == "text":
            return ChatChunk(type="text", text=chunk.text.text)
        elif which == "tool_call":
            return ChatChunk(
                type="tool_call",
                tool_name=chunk.tool_call.name,
                tool_args=chunk.tool_call.arguments,
            )
        elif which == "tool_result":
            return ChatChunk(
                type="tool_result",
                tool_name=chunk.tool_result.name,
                tool_result=chunk.tool_result.content,
            )
        elif which == "error":
            code = chunk.error.code
            message = chunk.error.message
            raise AbbenayError(f"Server error [{code}]: {message}")
        elif which == "done":
            return ChatChunk(
                type="done",
                finish_reason=chunk.done.finish_reason,
            )
        else:
            return ChatChunk(type=which or "unknown")
    
    def _parse_session(self, session) -> Session:
        """Parse a proto Session into our Session."""
        return Session(
            id=session.id,
            model=session.model,
            topic=session.topic or None,
            message_count=len(session.messages),
            source=proto.ClientType.Name(
                session.created_by.client_type if session.created_by else 0
            ).lower().replace("client_type_", ""),
            created_at=str(session.created_at),
            updated_at=str(session.updated_at),
        )
