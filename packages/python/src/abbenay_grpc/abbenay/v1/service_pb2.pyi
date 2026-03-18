from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Role(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ROLE_UNSPECIFIED: _ClassVar[Role]
    ROLE_SYSTEM: _ClassVar[Role]
    ROLE_USER: _ClassVar[Role]
    ROLE_ASSISTANT: _ClassVar[Role]
    ROLE_TOOL: _ClassVar[Role]

class ClientType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CLIENT_TYPE_UNSPECIFIED: _ClassVar[ClientType]
    CLIENT_TYPE_VSCODE: _ClassVar[ClientType]
    CLIENT_TYPE_CLI: _ClassVar[ClientType]
    CLIENT_TYPE_PYTHON: _ClassVar[ClientType]
    CLIENT_TYPE_NODEJS: _ClassVar[ClientType]
    CLIENT_TYPE_MCP: _ClassVar[ClientType]

class ReplayFormat(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    REPLAY_FORMAT_UNSPECIFIED: _ClassVar[ReplayFormat]
    REPLAY_FORMAT_FULL: _ClassVar[ReplayFormat]
    REPLAY_FORMAT_CONDENSED: _ClassVar[ReplayFormat]
    REPLAY_FORMAT_SUMMARY_ONLY: _ClassVar[ReplayFormat]

class ModelSource(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MODEL_SOURCE_UNSPECIFIED: _ClassVar[ModelSource]
    MODEL_SOURCE_DIRECT: _ClassVar[ModelSource]
    MODEL_SOURCE_VSCODE_LM: _ClassVar[ModelSource]

class ProviderType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PROVIDER_TYPE_UNSPECIFIED: _ClassVar[ProviderType]
    PROVIDER_TYPE_HTTP: _ClassVar[ProviderType]
    PROVIDER_TYPE_MCP: _ClassVar[ProviderType]
    PROVIDER_TYPE_LOCAL: _ClassVar[ProviderType]

class LogLevel(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LOG_LEVEL_UNSPECIFIED: _ClassVar[LogLevel]
    LOG_LEVEL_ERROR: _ClassVar[LogLevel]
    LOG_LEVEL_WARN: _ClassVar[LogLevel]
    LOG_LEVEL_INFO: _ClassVar[LogLevel]
    LOG_LEVEL_DEBUG: _ClassVar[LogLevel]
    LOG_LEVEL_TRACE: _ClassVar[LogLevel]

class SecretStore(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SECRET_STORE_UNSPECIFIED: _ClassVar[SecretStore]
    SECRET_STORE_KEYCHAIN: _ClassVar[SecretStore]
    SECRET_STORE_ENV: _ClassVar[SecretStore]
    SECRET_STORE_MEMORY: _ClassVar[SecretStore]
ROLE_UNSPECIFIED: Role
ROLE_SYSTEM: Role
ROLE_USER: Role
ROLE_ASSISTANT: Role
ROLE_TOOL: Role
CLIENT_TYPE_UNSPECIFIED: ClientType
CLIENT_TYPE_VSCODE: ClientType
CLIENT_TYPE_CLI: ClientType
CLIENT_TYPE_PYTHON: ClientType
CLIENT_TYPE_NODEJS: ClientType
CLIENT_TYPE_MCP: ClientType
REPLAY_FORMAT_UNSPECIFIED: ReplayFormat
REPLAY_FORMAT_FULL: ReplayFormat
REPLAY_FORMAT_CONDENSED: ReplayFormat
REPLAY_FORMAT_SUMMARY_ONLY: ReplayFormat
MODEL_SOURCE_UNSPECIFIED: ModelSource
MODEL_SOURCE_DIRECT: ModelSource
MODEL_SOURCE_VSCODE_LM: ModelSource
PROVIDER_TYPE_UNSPECIFIED: ProviderType
PROVIDER_TYPE_HTTP: ProviderType
PROVIDER_TYPE_MCP: ProviderType
PROVIDER_TYPE_LOCAL: ProviderType
LOG_LEVEL_UNSPECIFIED: LogLevel
LOG_LEVEL_ERROR: LogLevel
LOG_LEVEL_WARN: LogLevel
LOG_LEVEL_INFO: LogLevel
LOG_LEVEL_DEBUG: LogLevel
LOG_LEVEL_TRACE: LogLevel
SECRET_STORE_UNSPECIFIED: SecretStore
SECRET_STORE_KEYCHAIN: SecretStore
SECRET_STORE_ENV: SecretStore
SECRET_STORE_MEMORY: SecretStore

class Empty(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class Timestamp(_message.Message):
    __slots__ = ("seconds", "nanos")
    SECONDS_FIELD_NUMBER: _ClassVar[int]
    NANOS_FIELD_NUMBER: _ClassVar[int]
    seconds: int
    nanos: int
    def __init__(self, seconds: _Optional[int] = ..., nanos: _Optional[int] = ...) -> None: ...

class ListMcpToolsRequest(_message.Message):
    __slots__ = ("server_filter",)
    SERVER_FILTER_FIELD_NUMBER: _ClassVar[int]
    server_filter: str
    def __init__(self, server_filter: _Optional[str] = ...) -> None: ...

class ListMcpToolsResponse(_message.Message):
    __slots__ = ("tools",)
    TOOLS_FIELD_NUMBER: _ClassVar[int]
    tools: _containers.RepeatedCompositeFieldContainer[McpTool]
    def __init__(self, tools: _Optional[_Iterable[_Union[McpTool, _Mapping]]] = ...) -> None: ...

class McpTool(_message.Message):
    __slots__ = ("name", "description", "input_schema_json", "server_id", "annotations")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    INPUT_SCHEMA_JSON_FIELD_NUMBER: _ClassVar[int]
    SERVER_ID_FIELD_NUMBER: _ClassVar[int]
    ANNOTATIONS_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    input_schema_json: str
    server_id: str
    annotations: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., input_schema_json: _Optional[str] = ..., server_id: _Optional[str] = ..., annotations: _Optional[_Iterable[str]] = ...) -> None: ...

class CallToolRequest(_message.Message):
    __slots__ = ("tool_name", "arguments_json", "request_id", "context")
    class ContextEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    TOOL_NAME_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_FIELD_NUMBER: _ClassVar[int]
    tool_name: str
    arguments_json: str
    request_id: str
    context: _containers.ScalarMap[str, str]
    def __init__(self, tool_name: _Optional[str] = ..., arguments_json: _Optional[str] = ..., request_id: _Optional[str] = ..., context: _Optional[_Mapping[str, str]] = ...) -> None: ...

class ToolResponseChunk(_message.Message):
    __slots__ = ("request_id", "progress", "text_delta", "partial", "final_result", "error", "prompt")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    TEXT_DELTA_FIELD_NUMBER: _ClassVar[int]
    PARTIAL_FIELD_NUMBER: _ClassVar[int]
    FINAL_RESULT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    progress: ToolProgress
    text_delta: ToolTextDelta
    partial: ToolPartialResult
    final_result: ToolFinalResult
    error: ToolError
    prompt: ToolPrompt
    def __init__(self, request_id: _Optional[str] = ..., progress: _Optional[_Union[ToolProgress, _Mapping]] = ..., text_delta: _Optional[_Union[ToolTextDelta, _Mapping]] = ..., partial: _Optional[_Union[ToolPartialResult, _Mapping]] = ..., final_result: _Optional[_Union[ToolFinalResult, _Mapping]] = ..., error: _Optional[_Union[ToolError, _Mapping]] = ..., prompt: _Optional[_Union[ToolPrompt, _Mapping]] = ...) -> None: ...

class ToolProgress(_message.Message):
    __slots__ = ("percentage", "message", "eta_seconds")
    PERCENTAGE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    ETA_SECONDS_FIELD_NUMBER: _ClassVar[int]
    percentage: float
    message: str
    eta_seconds: int
    def __init__(self, percentage: _Optional[float] = ..., message: _Optional[str] = ..., eta_seconds: _Optional[int] = ...) -> None: ...

class ToolTextDelta(_message.Message):
    __slots__ = ("text",)
    TEXT_FIELD_NUMBER: _ClassVar[int]
    text: str
    def __init__(self, text: _Optional[str] = ...) -> None: ...

class ToolPartialResult(_message.Message):
    __slots__ = ("content_json", "is_final")
    CONTENT_JSON_FIELD_NUMBER: _ClassVar[int]
    IS_FINAL_FIELD_NUMBER: _ClassVar[int]
    content_json: str
    is_final: bool
    def __init__(self, content_json: _Optional[str] = ..., is_final: bool = ...) -> None: ...

class ToolFinalResult(_message.Message):
    __slots__ = ("content", "is_error")
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    IS_ERROR_FIELD_NUMBER: _ClassVar[int]
    content: _containers.RepeatedCompositeFieldContainer[ToolContent]
    is_error: bool
    def __init__(self, content: _Optional[_Iterable[_Union[ToolContent, _Mapping]]] = ..., is_error: bool = ...) -> None: ...

class ToolContent(_message.Message):
    __slots__ = ("type", "text", "mime_type", "data", "uri")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    URI_FIELD_NUMBER: _ClassVar[int]
    type: str
    text: str
    mime_type: str
    data: bytes
    uri: str
    def __init__(self, type: _Optional[str] = ..., text: _Optional[str] = ..., mime_type: _Optional[str] = ..., data: _Optional[bytes] = ..., uri: _Optional[str] = ...) -> None: ...

class ToolError(_message.Message):
    __slots__ = ("code", "message", "details_json")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DETAILS_JSON_FIELD_NUMBER: _ClassVar[int]
    code: str
    message: str
    details_json: str
    def __init__(self, code: _Optional[str] = ..., message: _Optional[str] = ..., details_json: _Optional[str] = ...) -> None: ...

class ToolPrompt(_message.Message):
    __slots__ = ("prompt_id", "message", "options", "default_value")
    PROMPT_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_VALUE_FIELD_NUMBER: _ClassVar[int]
    prompt_id: str
    message: str
    options: _containers.RepeatedScalarFieldContainer[str]
    default_value: str
    def __init__(self, prompt_id: _Optional[str] = ..., message: _Optional[str] = ..., options: _Optional[_Iterable[str]] = ..., default_value: _Optional[str] = ...) -> None: ...

class ToolInteractiveRequest(_message.Message):
    __slots__ = ("call", "response", "cancel")
    CALL_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FIELD_NUMBER: _ClassVar[int]
    CANCEL_FIELD_NUMBER: _ClassVar[int]
    call: CallToolRequest
    response: ToolPromptResponse
    cancel: ToolCancel
    def __init__(self, call: _Optional[_Union[CallToolRequest, _Mapping]] = ..., response: _Optional[_Union[ToolPromptResponse, _Mapping]] = ..., cancel: _Optional[_Union[ToolCancel, _Mapping]] = ...) -> None: ...

class ToolPromptResponse(_message.Message):
    __slots__ = ("prompt_id", "response")
    PROMPT_ID_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FIELD_NUMBER: _ClassVar[int]
    prompt_id: str
    response: str
    def __init__(self, prompt_id: _Optional[str] = ..., response: _Optional[str] = ...) -> None: ...

class ToolCancel(_message.Message):
    __slots__ = ("request_id", "reason")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    reason: str
    def __init__(self, request_id: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class CallToolsBatchRequest(_message.Message):
    __slots__ = ("calls", "stop_on_error")
    CALLS_FIELD_NUMBER: _ClassVar[int]
    STOP_ON_ERROR_FIELD_NUMBER: _ClassVar[int]
    calls: _containers.RepeatedCompositeFieldContainer[CallToolRequest]
    stop_on_error: bool
    def __init__(self, calls: _Optional[_Iterable[_Union[CallToolRequest, _Mapping]]] = ..., stop_on_error: bool = ...) -> None: ...

class ListResourcesRequest(_message.Message):
    __slots__ = ("server_filter", "uri_prefix")
    SERVER_FILTER_FIELD_NUMBER: _ClassVar[int]
    URI_PREFIX_FIELD_NUMBER: _ClassVar[int]
    server_filter: str
    uri_prefix: str
    def __init__(self, server_filter: _Optional[str] = ..., uri_prefix: _Optional[str] = ...) -> None: ...

class ListResourcesResponse(_message.Message):
    __slots__ = ("resources",)
    RESOURCES_FIELD_NUMBER: _ClassVar[int]
    resources: _containers.RepeatedCompositeFieldContainer[McpResource]
    def __init__(self, resources: _Optional[_Iterable[_Union[McpResource, _Mapping]]] = ...) -> None: ...

class McpResource(_message.Message):
    __slots__ = ("uri", "name", "description", "mime_type")
    URI_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    uri: str
    name: str
    description: str
    mime_type: str
    def __init__(self, uri: _Optional[str] = ..., name: _Optional[str] = ..., description: _Optional[str] = ..., mime_type: _Optional[str] = ...) -> None: ...

class ReadResourceRequest(_message.Message):
    __slots__ = ("uri",)
    URI_FIELD_NUMBER: _ClassVar[int]
    uri: str
    def __init__(self, uri: _Optional[str] = ...) -> None: ...

class ReadResourceResponse(_message.Message):
    __slots__ = ("contents",)
    CONTENTS_FIELD_NUMBER: _ClassVar[int]
    contents: _containers.RepeatedCompositeFieldContainer[ToolContent]
    def __init__(self, contents: _Optional[_Iterable[_Union[ToolContent, _Mapping]]] = ...) -> None: ...

class ListPromptsRequest(_message.Message):
    __slots__ = ("server_filter",)
    SERVER_FILTER_FIELD_NUMBER: _ClassVar[int]
    server_filter: str
    def __init__(self, server_filter: _Optional[str] = ...) -> None: ...

class ListPromptsResponse(_message.Message):
    __slots__ = ("prompts",)
    PROMPTS_FIELD_NUMBER: _ClassVar[int]
    prompts: _containers.RepeatedCompositeFieldContainer[McpPrompt]
    def __init__(self, prompts: _Optional[_Iterable[_Union[McpPrompt, _Mapping]]] = ...) -> None: ...

class McpPrompt(_message.Message):
    __slots__ = ("name", "description", "arguments")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    arguments: _containers.RepeatedCompositeFieldContainer[McpPromptArgument]
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., arguments: _Optional[_Iterable[_Union[McpPromptArgument, _Mapping]]] = ...) -> None: ...

class McpPromptArgument(_message.Message):
    __slots__ = ("name", "description", "required")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    required: bool
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., required: bool = ...) -> None: ...

class GetPromptRequest(_message.Message):
    __slots__ = ("name", "arguments")
    class ArgumentsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    NAME_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_FIELD_NUMBER: _ClassVar[int]
    name: str
    arguments: _containers.ScalarMap[str, str]
    def __init__(self, name: _Optional[str] = ..., arguments: _Optional[_Mapping[str, str]] = ...) -> None: ...

class GetPromptResponse(_message.Message):
    __slots__ = ("description", "messages")
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    description: str
    messages: _containers.RepeatedCompositeFieldContainer[PromptMessage]
    def __init__(self, description: _Optional[str] = ..., messages: _Optional[_Iterable[_Union[PromptMessage, _Mapping]]] = ...) -> None: ...

class PromptMessage(_message.Message):
    __slots__ = ("role", "content")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    role: str
    content: str
    def __init__(self, role: _Optional[str] = ..., content: _Optional[str] = ...) -> None: ...

class ChatRequest(_message.Message):
    __slots__ = ("model", "messages", "options", "tools", "policy")
    MODEL_FIELD_NUMBER: _ClassVar[int]
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    TOOLS_FIELD_NUMBER: _ClassVar[int]
    POLICY_FIELD_NUMBER: _ClassVar[int]
    model: str
    messages: _containers.RepeatedCompositeFieldContainer[Message]
    options: ChatOptions
    tools: _containers.RepeatedCompositeFieldContainer[Tool]
    policy: PolicyConfig
    def __init__(self, model: _Optional[str] = ..., messages: _Optional[_Iterable[_Union[Message, _Mapping]]] = ..., options: _Optional[_Union[ChatOptions, _Mapping]] = ..., tools: _Optional[_Iterable[_Union[Tool, _Mapping]]] = ..., policy: _Optional[_Union[PolicyConfig, _Mapping]] = ...) -> None: ...

class SessionChatRequest(_message.Message):
    __slots__ = ("session_id", "message", "options", "policy")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    POLICY_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    message: Message
    options: ChatOptions
    policy: PolicyConfig
    def __init__(self, session_id: _Optional[str] = ..., message: _Optional[_Union[Message, _Mapping]] = ..., options: _Optional[_Union[ChatOptions, _Mapping]] = ..., policy: _Optional[_Union[PolicyConfig, _Mapping]] = ...) -> None: ...

class ChatOptions(_message.Message):
    __slots__ = ("temperature", "max_tokens", "top_p", "stop", "enable_tools", "max_tool_iterations", "tool_filter", "top_k", "timeout", "tool_mode")
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOP_P_FIELD_NUMBER: _ClassVar[int]
    STOP_FIELD_NUMBER: _ClassVar[int]
    ENABLE_TOOLS_FIELD_NUMBER: _ClassVar[int]
    MAX_TOOL_ITERATIONS_FIELD_NUMBER: _ClassVar[int]
    TOOL_FILTER_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_FIELD_NUMBER: _ClassVar[int]
    TOOL_MODE_FIELD_NUMBER: _ClassVar[int]
    temperature: float
    max_tokens: int
    top_p: float
    stop: _containers.RepeatedScalarFieldContainer[str]
    enable_tools: bool
    max_tool_iterations: int
    tool_filter: _containers.RepeatedScalarFieldContainer[str]
    top_k: int
    timeout: int
    tool_mode: str
    def __init__(self, temperature: _Optional[float] = ..., max_tokens: _Optional[int] = ..., top_p: _Optional[float] = ..., stop: _Optional[_Iterable[str]] = ..., enable_tools: bool = ..., max_tool_iterations: _Optional[int] = ..., tool_filter: _Optional[_Iterable[str]] = ..., top_k: _Optional[int] = ..., timeout: _Optional[int] = ..., tool_mode: _Optional[str] = ...) -> None: ...

class ChatChunk(_message.Message):
    __slots__ = ("text", "tool_call", "tool_result", "prompt", "usage", "error", "done")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    TOOL_CALL_FIELD_NUMBER: _ClassVar[int]
    TOOL_RESULT_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DONE_FIELD_NUMBER: _ClassVar[int]
    text: TextChunk
    tool_call: ToolCallChunk
    tool_result: ToolResultChunk
    prompt: PromptChunk
    usage: UsageChunk
    error: ErrorChunk
    done: DoneChunk
    def __init__(self, text: _Optional[_Union[TextChunk, _Mapping]] = ..., tool_call: _Optional[_Union[ToolCallChunk, _Mapping]] = ..., tool_result: _Optional[_Union[ToolResultChunk, _Mapping]] = ..., prompt: _Optional[_Union[PromptChunk, _Mapping]] = ..., usage: _Optional[_Union[UsageChunk, _Mapping]] = ..., error: _Optional[_Union[ErrorChunk, _Mapping]] = ..., done: _Optional[_Union[DoneChunk, _Mapping]] = ...) -> None: ...

class TextChunk(_message.Message):
    __slots__ = ("text",)
    TEXT_FIELD_NUMBER: _ClassVar[int]
    text: str
    def __init__(self, text: _Optional[str] = ...) -> None: ...

class ToolCallChunk(_message.Message):
    __slots__ = ("id", "name", "arguments")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    arguments: str
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., arguments: _Optional[str] = ...) -> None: ...

class ToolResultChunk(_message.Message):
    __slots__ = ("tool_call_id", "name", "content", "is_error")
    TOOL_CALL_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    IS_ERROR_FIELD_NUMBER: _ClassVar[int]
    tool_call_id: str
    name: str
    content: str
    is_error: bool
    def __init__(self, tool_call_id: _Optional[str] = ..., name: _Optional[str] = ..., content: _Optional[str] = ..., is_error: bool = ...) -> None: ...

class PromptChunk(_message.Message):
    __slots__ = ("tool_call_id", "tool_name", "prompt_text", "options")
    TOOL_CALL_ID_FIELD_NUMBER: _ClassVar[int]
    TOOL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROMPT_TEXT_FIELD_NUMBER: _ClassVar[int]
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    tool_call_id: str
    tool_name: str
    prompt_text: str
    options: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tool_call_id: _Optional[str] = ..., tool_name: _Optional[str] = ..., prompt_text: _Optional[str] = ..., options: _Optional[_Iterable[str]] = ...) -> None: ...

class UsageChunk(_message.Message):
    __slots__ = ("prompt_tokens", "completion_tokens", "total_tokens")
    PROMPT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    COMPLETION_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    def __init__(self, prompt_tokens: _Optional[int] = ..., completion_tokens: _Optional[int] = ..., total_tokens: _Optional[int] = ...) -> None: ...

class ErrorChunk(_message.Message):
    __slots__ = ("code", "message")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    code: str
    message: str
    def __init__(self, code: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class DoneChunk(_message.Message):
    __slots__ = ("finish_reason",)
    FINISH_REASON_FIELD_NUMBER: _ClassVar[int]
    finish_reason: str
    def __init__(self, finish_reason: _Optional[str] = ...) -> None: ...

class Message(_message.Message):
    __slots__ = ("role", "content", "tool_calls", "tool_call_id", "name")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    TOOL_CALLS_FIELD_NUMBER: _ClassVar[int]
    TOOL_CALL_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    role: Role
    content: str
    tool_calls: _containers.RepeatedCompositeFieldContainer[ToolCall]
    tool_call_id: str
    name: str
    def __init__(self, role: _Optional[_Union[Role, str]] = ..., content: _Optional[str] = ..., tool_calls: _Optional[_Iterable[_Union[ToolCall, _Mapping]]] = ..., tool_call_id: _Optional[str] = ..., name: _Optional[str] = ...) -> None: ...

class ToolCall(_message.Message):
    __slots__ = ("id", "name", "arguments")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    arguments: str
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., arguments: _Optional[str] = ...) -> None: ...

class Session(_message.Message):
    __slots__ = ("id", "model", "topic", "messages", "created_by", "created_at", "updated_at", "metadata", "forked_from", "fork_point", "cached_summary")
    class MetadataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    TOPIC_FIELD_NUMBER: _ClassVar[int]
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    FORKED_FROM_FIELD_NUMBER: _ClassVar[int]
    FORK_POINT_FIELD_NUMBER: _ClassVar[int]
    CACHED_SUMMARY_FIELD_NUMBER: _ClassVar[int]
    id: str
    model: str
    topic: str
    messages: _containers.RepeatedCompositeFieldContainer[Message]
    created_by: ClientInfo
    created_at: Timestamp
    updated_at: Timestamp
    metadata: _containers.ScalarMap[str, str]
    forked_from: str
    fork_point: int
    cached_summary: str
    def __init__(self, id: _Optional[str] = ..., model: _Optional[str] = ..., topic: _Optional[str] = ..., messages: _Optional[_Iterable[_Union[Message, _Mapping]]] = ..., created_by: _Optional[_Union[ClientInfo, _Mapping]] = ..., created_at: _Optional[_Union[Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[Timestamp, _Mapping]] = ..., metadata: _Optional[_Mapping[str, str]] = ..., forked_from: _Optional[str] = ..., fork_point: _Optional[int] = ..., cached_summary: _Optional[str] = ...) -> None: ...

class ClientInfo(_message.Message):
    __slots__ = ("client_type", "client_id", "user")
    CLIENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    CLIENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_FIELD_NUMBER: _ClassVar[int]
    client_type: ClientType
    client_id: str
    user: str
    def __init__(self, client_type: _Optional[_Union[ClientType, str]] = ..., client_id: _Optional[str] = ..., user: _Optional[str] = ...) -> None: ...

class CreateSessionRequest(_message.Message):
    __slots__ = ("model", "topic", "metadata")
    class MetadataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    MODEL_FIELD_NUMBER: _ClassVar[int]
    TOPIC_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    model: str
    topic: str
    metadata: _containers.ScalarMap[str, str]
    def __init__(self, model: _Optional[str] = ..., topic: _Optional[str] = ..., metadata: _Optional[_Mapping[str, str]] = ...) -> None: ...

class GetSessionRequest(_message.Message):
    __slots__ = ("session_id", "include_messages")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_MESSAGES_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    include_messages: bool
    def __init__(self, session_id: _Optional[str] = ..., include_messages: bool = ...) -> None: ...

class ListSessionsRequest(_message.Message):
    __slots__ = ("limit", "offset", "source_filter", "model_filter")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FILTER_FIELD_NUMBER: _ClassVar[int]
    MODEL_FILTER_FIELD_NUMBER: _ClassVar[int]
    limit: int
    offset: int
    source_filter: str
    model_filter: str
    def __init__(self, limit: _Optional[int] = ..., offset: _Optional[int] = ..., source_filter: _Optional[str] = ..., model_filter: _Optional[str] = ...) -> None: ...

class ListSessionsResponse(_message.Message):
    __slots__ = ("sessions", "total_count")
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_COUNT_FIELD_NUMBER: _ClassVar[int]
    sessions: _containers.RepeatedCompositeFieldContainer[SessionSummary]
    total_count: int
    def __init__(self, sessions: _Optional[_Iterable[_Union[SessionSummary, _Mapping]]] = ..., total_count: _Optional[int] = ...) -> None: ...

class SessionSummary(_message.Message):
    __slots__ = ("id", "model", "topic", "message_count", "source", "created_at", "updated_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    TOPIC_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    model: str
    topic: str
    message_count: int
    source: ClientType
    created_at: Timestamp
    updated_at: Timestamp
    def __init__(self, id: _Optional[str] = ..., model: _Optional[str] = ..., topic: _Optional[str] = ..., message_count: _Optional[int] = ..., source: _Optional[_Union[ClientType, str]] = ..., created_at: _Optional[_Union[Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[Timestamp, _Mapping]] = ...) -> None: ...

class DeleteSessionRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class WatchSessionsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class SessionEvent(_message.Message):
    __slots__ = ("session_id", "created", "updated", "deleted")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_FIELD_NUMBER: _ClassVar[int]
    UPDATED_FIELD_NUMBER: _ClassVar[int]
    DELETED_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    created: SessionCreated
    updated: SessionUpdated
    deleted: SessionDeleted
    def __init__(self, session_id: _Optional[str] = ..., created: _Optional[_Union[SessionCreated, _Mapping]] = ..., updated: _Optional[_Union[SessionUpdated, _Mapping]] = ..., deleted: _Optional[_Union[SessionDeleted, _Mapping]] = ...) -> None: ...

class SessionCreated(_message.Message):
    __slots__ = ("session",)
    SESSION_FIELD_NUMBER: _ClassVar[int]
    session: SessionSummary
    def __init__(self, session: _Optional[_Union[SessionSummary, _Mapping]] = ...) -> None: ...

class SessionUpdated(_message.Message):
    __slots__ = ("session", "new_message_count")
    SESSION_FIELD_NUMBER: _ClassVar[int]
    NEW_MESSAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    session: SessionSummary
    new_message_count: int
    def __init__(self, session: _Optional[_Union[SessionSummary, _Mapping]] = ..., new_message_count: _Optional[int] = ...) -> None: ...

class SessionDeleted(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ReplaySessionRequest(_message.Message):
    __slots__ = ("session_id", "format", "max_messages")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    MAX_MESSAGES_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    format: ReplayFormat
    max_messages: int
    def __init__(self, session_id: _Optional[str] = ..., format: _Optional[_Union[ReplayFormat, str]] = ..., max_messages: _Optional[int] = ...) -> None: ...

class ReplaySessionResponse(_message.Message):
    __slots__ = ("formatted_content", "message_count", "token_estimate")
    FORMATTED_CONTENT_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    TOKEN_ESTIMATE_FIELD_NUMBER: _ClassVar[int]
    formatted_content: str
    message_count: int
    token_estimate: int
    def __init__(self, formatted_content: _Optional[str] = ..., message_count: _Optional[int] = ..., token_estimate: _Optional[int] = ...) -> None: ...

class SummarizeSessionRequest(_message.Message):
    __slots__ = ("session_id", "summarize_model")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    SUMMARIZE_MODEL_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    summarize_model: str
    def __init__(self, session_id: _Optional[str] = ..., summarize_model: _Optional[str] = ...) -> None: ...

class SummarizeSessionResponse(_message.Message):
    __slots__ = ("summary", "from_cache")
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    FROM_CACHE_FIELD_NUMBER: _ClassVar[int]
    summary: str
    from_cache: bool
    def __init__(self, summary: _Optional[str] = ..., from_cache: bool = ...) -> None: ...

class ForkSessionRequest(_message.Message):
    __slots__ = ("session_id", "new_model", "fork_point")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    NEW_MODEL_FIELD_NUMBER: _ClassVar[int]
    FORK_POINT_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    new_model: str
    fork_point: int
    def __init__(self, session_id: _Optional[str] = ..., new_model: _Optional[str] = ..., fork_point: _Optional[int] = ...) -> None: ...

class ExportSessionRequest(_message.Message):
    __slots__ = ("session_id", "include_tool_results", "include_metadata")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_TOOL_RESULTS_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_METADATA_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    include_tool_results: bool
    include_metadata: bool
    def __init__(self, session_id: _Optional[str] = ..., include_tool_results: bool = ..., include_metadata: bool = ...) -> None: ...

class ExportSessionResponse(_message.Message):
    __slots__ = ("json_content",)
    JSON_CONTENT_FIELD_NUMBER: _ClassVar[int]
    json_content: str
    def __init__(self, json_content: _Optional[str] = ...) -> None: ...

class ImportSessionRequest(_message.Message):
    __slots__ = ("json_content", "generate_new_id")
    JSON_CONTENT_FIELD_NUMBER: _ClassVar[int]
    GENERATE_NEW_ID_FIELD_NUMBER: _ClassVar[int]
    json_content: str
    generate_new_id: bool
    def __init__(self, json_content: _Optional[str] = ..., generate_new_id: bool = ...) -> None: ...

class ListModelsRequest(_message.Message):
    __slots__ = ("provider_filter", "workspace_paths")
    PROVIDER_FILTER_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_PATHS_FIELD_NUMBER: _ClassVar[int]
    provider_filter: str
    workspace_paths: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, provider_filter: _Optional[str] = ..., workspace_paths: _Optional[_Iterable[str]] = ...) -> None: ...

class ListModelsResponse(_message.Message):
    __slots__ = ("models",)
    MODELS_FIELD_NUMBER: _ClassVar[int]
    models: _containers.RepeatedCompositeFieldContainer[Model]
    def __init__(self, models: _Optional[_Iterable[_Union[Model, _Mapping]]] = ...) -> None: ...

class DiscoverModelsRequest(_message.Message):
    __slots__ = ("engine_id", "api_key", "base_url")
    ENGINE_ID_FIELD_NUMBER: _ClassVar[int]
    API_KEY_FIELD_NUMBER: _ClassVar[int]
    BASE_URL_FIELD_NUMBER: _ClassVar[int]
    engine_id: str
    api_key: str
    base_url: str
    def __init__(self, engine_id: _Optional[str] = ..., api_key: _Optional[str] = ..., base_url: _Optional[str] = ...) -> None: ...

class DiscoverModelsResponse(_message.Message):
    __slots__ = ("models",)
    MODELS_FIELD_NUMBER: _ClassVar[int]
    models: _containers.RepeatedCompositeFieldContainer[Model]
    def __init__(self, models: _Optional[_Iterable[_Union[Model, _Mapping]]] = ...) -> None: ...

class Model(_message.Message):
    __slots__ = ("id", "provider", "name", "capabilities", "source", "engine", "params", "engine_model_id", "policy")
    ID_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    ENGINE_FIELD_NUMBER: _ClassVar[int]
    PARAMS_FIELD_NUMBER: _ClassVar[int]
    ENGINE_MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    POLICY_FIELD_NUMBER: _ClassVar[int]
    id: str
    provider: str
    name: str
    capabilities: ModelCapabilities
    source: ModelSource
    engine: str
    params: ModelParams
    engine_model_id: str
    policy: str
    def __init__(self, id: _Optional[str] = ..., provider: _Optional[str] = ..., name: _Optional[str] = ..., capabilities: _Optional[_Union[ModelCapabilities, _Mapping]] = ..., source: _Optional[_Union[ModelSource, str]] = ..., engine: _Optional[str] = ..., params: _Optional[_Union[ModelParams, _Mapping]] = ..., engine_model_id: _Optional[str] = ..., policy: _Optional[str] = ...) -> None: ...

class ModelParams(_message.Message):
    __slots__ = ("temperature", "top_p", "max_tokens", "system_prompt", "system_prompt_mode", "top_k", "timeout")
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    TOP_P_FIELD_NUMBER: _ClassVar[int]
    MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_PROMPT_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_PROMPT_MODE_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_FIELD_NUMBER: _ClassVar[int]
    temperature: float
    top_p: float
    max_tokens: int
    system_prompt: str
    system_prompt_mode: str
    top_k: int
    timeout: int
    def __init__(self, temperature: _Optional[float] = ..., top_p: _Optional[float] = ..., max_tokens: _Optional[int] = ..., system_prompt: _Optional[str] = ..., system_prompt_mode: _Optional[str] = ..., top_k: _Optional[int] = ..., timeout: _Optional[int] = ...) -> None: ...

class ModelCapabilities(_message.Message):
    __slots__ = ("supports_streaming", "supports_tools", "supports_vision", "context_window")
    SUPPORTS_STREAMING_FIELD_NUMBER: _ClassVar[int]
    SUPPORTS_TOOLS_FIELD_NUMBER: _ClassVar[int]
    SUPPORTS_VISION_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_WINDOW_FIELD_NUMBER: _ClassVar[int]
    supports_streaming: bool
    supports_tools: bool
    supports_vision: bool
    context_window: int
    def __init__(self, supports_streaming: bool = ..., supports_tools: bool = ..., supports_vision: bool = ..., context_window: _Optional[int] = ...) -> None: ...

class ListProvidersRequest(_message.Message):
    __slots__ = ("workspace_paths",)
    WORKSPACE_PATHS_FIELD_NUMBER: _ClassVar[int]
    workspace_paths: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, workspace_paths: _Optional[_Iterable[str]] = ...) -> None: ...

class ListProvidersResponse(_message.Message):
    __slots__ = ("providers",)
    PROVIDERS_FIELD_NUMBER: _ClassVar[int]
    providers: _containers.RepeatedCompositeFieldContainer[Provider]
    def __init__(self, providers: _Optional[_Iterable[_Union[Provider, _Mapping]]] = ...) -> None: ...

class Provider(_message.Message):
    __slots__ = ("id", "configured", "healthy", "provider_type", "requires_key", "default_base_url", "engine", "base_url")
    ID_FIELD_NUMBER: _ClassVar[int]
    CONFIGURED_FIELD_NUMBER: _ClassVar[int]
    HEALTHY_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    REQUIRES_KEY_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_BASE_URL_FIELD_NUMBER: _ClassVar[int]
    ENGINE_FIELD_NUMBER: _ClassVar[int]
    BASE_URL_FIELD_NUMBER: _ClassVar[int]
    id: str
    configured: bool
    healthy: bool
    provider_type: ProviderType
    requires_key: bool
    default_base_url: str
    engine: str
    base_url: str
    def __init__(self, id: _Optional[str] = ..., configured: bool = ..., healthy: bool = ..., provider_type: _Optional[_Union[ProviderType, str]] = ..., requires_key: bool = ..., default_base_url: _Optional[str] = ..., engine: _Optional[str] = ..., base_url: _Optional[str] = ...) -> None: ...

class GetProviderStatusRequest(_message.Message):
    __slots__ = ("provider_id",)
    PROVIDER_ID_FIELD_NUMBER: _ClassVar[int]
    provider_id: str
    def __init__(self, provider_id: _Optional[str] = ...) -> None: ...

class ProviderStatus(_message.Message):
    __slots__ = ("provider_id", "configured", "healthy", "error", "last_check")
    PROVIDER_ID_FIELD_NUMBER: _ClassVar[int]
    CONFIGURED_FIELD_NUMBER: _ClassVar[int]
    HEALTHY_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    LAST_CHECK_FIELD_NUMBER: _ClassVar[int]
    provider_id: str
    configured: bool
    healthy: bool
    error: str
    last_check: Timestamp
    def __init__(self, provider_id: _Optional[str] = ..., configured: bool = ..., healthy: bool = ..., error: _Optional[str] = ..., last_check: _Optional[_Union[Timestamp, _Mapping]] = ...) -> None: ...

class ListEnginesRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListEnginesResponse(_message.Message):
    __slots__ = ("engines",)
    ENGINES_FIELD_NUMBER: _ClassVar[int]
    engines: _containers.RepeatedCompositeFieldContainer[Engine]
    def __init__(self, engines: _Optional[_Iterable[_Union[Engine, _Mapping]]] = ...) -> None: ...

class Engine(_message.Message):
    __slots__ = ("id", "requires_key", "default_base_url", "default_env_var")
    ID_FIELD_NUMBER: _ClassVar[int]
    REQUIRES_KEY_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_BASE_URL_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_ENV_VAR_FIELD_NUMBER: _ClassVar[int]
    id: str
    requires_key: bool
    default_base_url: str
    default_env_var: str
    def __init__(self, id: _Optional[str] = ..., requires_key: bool = ..., default_base_url: _Optional[str] = ..., default_env_var: _Optional[str] = ...) -> None: ...

class ListToolsRequest(_message.Message):
    __slots__ = ("server_filter",)
    SERVER_FILTER_FIELD_NUMBER: _ClassVar[int]
    server_filter: str
    def __init__(self, server_filter: _Optional[str] = ...) -> None: ...

class ListToolsResponse(_message.Message):
    __slots__ = ("tools",)
    TOOLS_FIELD_NUMBER: _ClassVar[int]
    tools: _containers.RepeatedCompositeFieldContainer[Tool]
    def __init__(self, tools: _Optional[_Iterable[_Union[Tool, _Mapping]]] = ...) -> None: ...

class Tool(_message.Message):
    __slots__ = ("name", "description", "input_schema", "server")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    INPUT_SCHEMA_FIELD_NUMBER: _ClassVar[int]
    SERVER_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    input_schema: str
    server: str
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., input_schema: _Optional[str] = ..., server: _Optional[str] = ...) -> None: ...

class ExecuteToolRequest(_message.Message):
    __slots__ = ("name", "arguments")
    NAME_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_FIELD_NUMBER: _ClassVar[int]
    name: str
    arguments: str
    def __init__(self, name: _Optional[str] = ..., arguments: _Optional[str] = ...) -> None: ...

class ExecuteToolResponse(_message.Message):
    __slots__ = ("content", "is_error")
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    IS_ERROR_FIELD_NUMBER: _ClassVar[int]
    content: str
    is_error: bool
    def __init__(self, content: _Optional[str] = ..., is_error: bool = ...) -> None: ...

class GetConfigRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class Config(_message.Message):
    __slots__ = ("default_model", "providers", "session_ttl_days", "log_level")
    class ProvidersEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: ProviderConfig
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[ProviderConfig, _Mapping]] = ...) -> None: ...
    DEFAULT_MODEL_FIELD_NUMBER: _ClassVar[int]
    PROVIDERS_FIELD_NUMBER: _ClassVar[int]
    SESSION_TTL_DAYS_FIELD_NUMBER: _ClassVar[int]
    LOG_LEVEL_FIELD_NUMBER: _ClassVar[int]
    default_model: str
    providers: _containers.MessageMap[str, ProviderConfig]
    session_ttl_days: int
    log_level: LogLevel
    def __init__(self, default_model: _Optional[str] = ..., providers: _Optional[_Mapping[str, ProviderConfig]] = ..., session_ttl_days: _Optional[int] = ..., log_level: _Optional[_Union[LogLevel, str]] = ...) -> None: ...

class ProviderConfig(_message.Message):
    __slots__ = ("enabled", "api_key_ref", "base_url", "extra")
    class ExtraEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    ENABLED_FIELD_NUMBER: _ClassVar[int]
    API_KEY_REF_FIELD_NUMBER: _ClassVar[int]
    BASE_URL_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    enabled: bool
    api_key_ref: str
    base_url: str
    extra: _containers.ScalarMap[str, str]
    def __init__(self, enabled: bool = ..., api_key_ref: _Optional[str] = ..., base_url: _Optional[str] = ..., extra: _Optional[_Mapping[str, str]] = ...) -> None: ...

class UpdateConfigRequest(_message.Message):
    __slots__ = ("config", "update_mask")
    CONFIG_FIELD_NUMBER: _ClassVar[int]
    UPDATE_MASK_FIELD_NUMBER: _ClassVar[int]
    config: Config
    update_mask: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, config: _Optional[_Union[Config, _Mapping]] = ..., update_mask: _Optional[_Iterable[str]] = ...) -> None: ...

class GetSecretRequest(_message.Message):
    __slots__ = ("key",)
    KEY_FIELD_NUMBER: _ClassVar[int]
    key: str
    def __init__(self, key: _Optional[str] = ...) -> None: ...

class GetSecretResponse(_message.Message):
    __slots__ = ("value",)
    VALUE_FIELD_NUMBER: _ClassVar[int]
    value: str
    def __init__(self, value: _Optional[str] = ...) -> None: ...

class SetSecretRequest(_message.Message):
    __slots__ = ("key", "value", "store")
    KEY_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    STORE_FIELD_NUMBER: _ClassVar[int]
    key: str
    value: str
    store: SecretStore
    def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ..., store: _Optional[_Union[SecretStore, str]] = ...) -> None: ...

class DeleteSecretRequest(_message.Message):
    __slots__ = ("key",)
    KEY_FIELD_NUMBER: _ClassVar[int]
    key: str
    def __init__(self, key: _Optional[str] = ...) -> None: ...

class ListSecretsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListSecretsResponse(_message.Message):
    __slots__ = ("secrets",)
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    secrets: _containers.RepeatedCompositeFieldContainer[SecretInfo]
    def __init__(self, secrets: _Optional[_Iterable[_Union[SecretInfo, _Mapping]]] = ...) -> None: ...

class SecretInfo(_message.Message):
    __slots__ = ("key", "store", "has_value")
    KEY_FIELD_NUMBER: _ClassVar[int]
    STORE_FIELD_NUMBER: _ClassVar[int]
    HAS_VALUE_FIELD_NUMBER: _ClassVar[int]
    key: str
    store: SecretStore
    has_value: bool
    def __init__(self, key: _Optional[str] = ..., store: _Optional[_Union[SecretStore, str]] = ..., has_value: bool = ...) -> None: ...

class RegisterRequest(_message.Message):
    __slots__ = ("client", "is_spawner", "workspace_path", "workspace_paths")
    CLIENT_FIELD_NUMBER: _ClassVar[int]
    IS_SPAWNER_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_PATH_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_PATHS_FIELD_NUMBER: _ClassVar[int]
    client: ClientInfo
    is_spawner: bool
    workspace_path: str
    workspace_paths: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, client: _Optional[_Union[ClientInfo, _Mapping]] = ..., is_spawner: bool = ..., workspace_path: _Optional[str] = ..., workspace_paths: _Optional[_Iterable[str]] = ...) -> None: ...

class RegisterResponse(_message.Message):
    __slots__ = ("client_id", "connected_clients")
    CLIENT_ID_FIELD_NUMBER: _ClassVar[int]
    CONNECTED_CLIENTS_FIELD_NUMBER: _ClassVar[int]
    client_id: str
    connected_clients: int
    def __init__(self, client_id: _Optional[str] = ..., connected_clients: _Optional[int] = ...) -> None: ...

class UnregisterRequest(_message.Message):
    __slots__ = ("client_id",)
    CLIENT_ID_FIELD_NUMBER: _ClassVar[int]
    client_id: str
    def __init__(self, client_id: _Optional[str] = ...) -> None: ...

class GetStatusRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GetConnectedWorkspacesRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GetConnectedWorkspacesResponse(_message.Message):
    __slots__ = ("workspaces",)
    WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    workspaces: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, workspaces: _Optional[_Iterable[str]] = ...) -> None: ...

class DaemonStatus(_message.Message):
    __slots__ = ("version", "started_at", "connected_clients", "active_sessions", "clients", "registered_mcp_servers")
    VERSION_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    CONNECTED_CLIENTS_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_SESSIONS_FIELD_NUMBER: _ClassVar[int]
    CLIENTS_FIELD_NUMBER: _ClassVar[int]
    REGISTERED_MCP_SERVERS_FIELD_NUMBER: _ClassVar[int]
    version: str
    started_at: Timestamp
    connected_clients: int
    active_sessions: int
    clients: _containers.RepeatedCompositeFieldContainer[ConnectedClient]
    registered_mcp_servers: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, version: _Optional[str] = ..., started_at: _Optional[_Union[Timestamp, _Mapping]] = ..., connected_clients: _Optional[int] = ..., active_sessions: _Optional[int] = ..., clients: _Optional[_Iterable[_Union[ConnectedClient, _Mapping]]] = ..., registered_mcp_servers: _Optional[_Iterable[str]] = ...) -> None: ...

class ConnectedClient(_message.Message):
    __slots__ = ("client_id", "client_type", "connected_at", "is_spawner", "workspace_path")
    CLIENT_ID_FIELD_NUMBER: _ClassVar[int]
    CLIENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    CONNECTED_AT_FIELD_NUMBER: _ClassVar[int]
    IS_SPAWNER_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_PATH_FIELD_NUMBER: _ClassVar[int]
    client_id: str
    client_type: ClientType
    connected_at: Timestamp
    is_spawner: bool
    workspace_path: str
    def __init__(self, client_id: _Optional[str] = ..., client_type: _Optional[_Union[ClientType, str]] = ..., connected_at: _Optional[_Union[Timestamp, _Mapping]] = ..., is_spawner: bool = ..., workspace_path: _Optional[str] = ...) -> None: ...

class ShutdownRequest(_message.Message):
    __slots__ = ("force", "grace_period_seconds")
    FORCE_FIELD_NUMBER: _ClassVar[int]
    GRACE_PERIOD_SECONDS_FIELD_NUMBER: _ClassVar[int]
    force: bool
    grace_period_seconds: int
    def __init__(self, force: bool = ..., grace_period_seconds: _Optional[int] = ...) -> None: ...

class HealthCheckRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class HealthCheckResponse(_message.Message):
    __slots__ = ("healthy", "version")
    HEALTHY_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    healthy: bool
    version: str
    def __init__(self, healthy: bool = ..., version: _Optional[str] = ...) -> None: ...

class StartWebServerRequest(_message.Message):
    __slots__ = ("port",)
    PORT_FIELD_NUMBER: _ClassVar[int]
    port: int
    def __init__(self, port: _Optional[int] = ...) -> None: ...

class StartWebServerResponse(_message.Message):
    __slots__ = ("started", "already_running", "port", "url")
    STARTED_FIELD_NUMBER: _ClassVar[int]
    ALREADY_RUNNING_FIELD_NUMBER: _ClassVar[int]
    PORT_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    started: bool
    already_running: bool
    port: int
    url: str
    def __init__(self, started: bool = ..., already_running: bool = ..., port: _Optional[int] = ..., url: _Optional[str] = ...) -> None: ...

class StopWebServerRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class VSCodeRequest(_message.Message):
    __slots__ = ("request_id", "invoke_tool", "list_models", "send_chat", "get_workspace", "models_changed", "list_tools")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    INVOKE_TOOL_FIELD_NUMBER: _ClassVar[int]
    LIST_MODELS_FIELD_NUMBER: _ClassVar[int]
    SEND_CHAT_FIELD_NUMBER: _ClassVar[int]
    GET_WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    MODELS_CHANGED_FIELD_NUMBER: _ClassVar[int]
    LIST_TOOLS_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    invoke_tool: InvokeToolRequest
    list_models: ListVSCodeModelsRequest
    send_chat: SendVSCodeChatRequest
    get_workspace: GetWorkspaceRequest
    models_changed: ModelsChangedNotification
    list_tools: ListVSCodeToolsRequest
    def __init__(self, request_id: _Optional[str] = ..., invoke_tool: _Optional[_Union[InvokeToolRequest, _Mapping]] = ..., list_models: _Optional[_Union[ListVSCodeModelsRequest, _Mapping]] = ..., send_chat: _Optional[_Union[SendVSCodeChatRequest, _Mapping]] = ..., get_workspace: _Optional[_Union[GetWorkspaceRequest, _Mapping]] = ..., models_changed: _Optional[_Union[ModelsChangedNotification, _Mapping]] = ..., list_tools: _Optional[_Union[ListVSCodeToolsRequest, _Mapping]] = ...) -> None: ...

class ModelsChangedNotification(_message.Message):
    __slots__ = ("reason",)
    REASON_FIELD_NUMBER: _ClassVar[int]
    reason: str
    def __init__(self, reason: _Optional[str] = ...) -> None: ...

class VSCodeResponse(_message.Message):
    __slots__ = ("request_id", "invoke_tool", "list_models", "send_chat", "error", "get_workspace", "list_tools", "register_tools")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    INVOKE_TOOL_FIELD_NUMBER: _ClassVar[int]
    LIST_MODELS_FIELD_NUMBER: _ClassVar[int]
    SEND_CHAT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    GET_WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    LIST_TOOLS_FIELD_NUMBER: _ClassVar[int]
    REGISTER_TOOLS_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    invoke_tool: InvokeToolResponse
    list_models: ListVSCodeModelsResponse
    send_chat: SendVSCodeChatResponse
    error: VSCodeError
    get_workspace: GetWorkspaceResponse
    list_tools: ListVSCodeToolsResponse
    register_tools: RegisterToolsNotification
    def __init__(self, request_id: _Optional[str] = ..., invoke_tool: _Optional[_Union[InvokeToolResponse, _Mapping]] = ..., list_models: _Optional[_Union[ListVSCodeModelsResponse, _Mapping]] = ..., send_chat: _Optional[_Union[SendVSCodeChatResponse, _Mapping]] = ..., error: _Optional[_Union[VSCodeError, _Mapping]] = ..., get_workspace: _Optional[_Union[GetWorkspaceResponse, _Mapping]] = ..., list_tools: _Optional[_Union[ListVSCodeToolsResponse, _Mapping]] = ..., register_tools: _Optional[_Union[RegisterToolsNotification, _Mapping]] = ...) -> None: ...

class GetWorkspaceRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GetWorkspaceResponse(_message.Message):
    __slots__ = ("workspace_path", "workspace_folders")
    WORKSPACE_PATH_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FOLDERS_FIELD_NUMBER: _ClassVar[int]
    workspace_path: str
    workspace_folders: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, workspace_path: _Optional[str] = ..., workspace_folders: _Optional[_Iterable[str]] = ...) -> None: ...

class VSCodeError(_message.Message):
    __slots__ = ("message", "code")
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    CODE_FIELD_NUMBER: _ClassVar[int]
    message: str
    code: str
    def __init__(self, message: _Optional[str] = ..., code: _Optional[str] = ...) -> None: ...

class InvokeToolRequest(_message.Message):
    __slots__ = ("tool_name", "arguments_json")
    TOOL_NAME_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    tool_name: str
    arguments_json: str
    def __init__(self, tool_name: _Optional[str] = ..., arguments_json: _Optional[str] = ...) -> None: ...

class InvokeToolResponse(_message.Message):
    __slots__ = ("result_json", "is_error")
    RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    IS_ERROR_FIELD_NUMBER: _ClassVar[int]
    result_json: str
    is_error: bool
    def __init__(self, result_json: _Optional[str] = ..., is_error: bool = ...) -> None: ...

class ListVSCodeToolsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListVSCodeToolsResponse(_message.Message):
    __slots__ = ("tools",)
    TOOLS_FIELD_NUMBER: _ClassVar[int]
    tools: _containers.RepeatedCompositeFieldContainer[VSCodeToolInfo]
    def __init__(self, tools: _Optional[_Iterable[_Union[VSCodeToolInfo, _Mapping]]] = ...) -> None: ...

class RegisterToolsNotification(_message.Message):
    __slots__ = ("tools",)
    TOOLS_FIELD_NUMBER: _ClassVar[int]
    tools: _containers.RepeatedCompositeFieldContainer[VSCodeToolInfo]
    def __init__(self, tools: _Optional[_Iterable[_Union[VSCodeToolInfo, _Mapping]]] = ...) -> None: ...

class VSCodeToolInfo(_message.Message):
    __slots__ = ("name", "description", "input_schema", "tags")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    INPUT_SCHEMA_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    input_schema: str
    tags: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., input_schema: _Optional[str] = ..., tags: _Optional[_Iterable[str]] = ...) -> None: ...

class ListVSCodeModelsRequest(_message.Message):
    __slots__ = ("family_filter",)
    FAMILY_FILTER_FIELD_NUMBER: _ClassVar[int]
    family_filter: str
    def __init__(self, family_filter: _Optional[str] = ...) -> None: ...

class ListVSCodeModelsResponse(_message.Message):
    __slots__ = ("models",)
    MODELS_FIELD_NUMBER: _ClassVar[int]
    models: _containers.RepeatedCompositeFieldContainer[VSCodeModel]
    def __init__(self, models: _Optional[_Iterable[_Union[VSCodeModel, _Mapping]]] = ...) -> None: ...

class VSCodeModel(_message.Message):
    __slots__ = ("id", "name", "vendor", "family", "max_input_tokens")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    VENDOR_FIELD_NUMBER: _ClassVar[int]
    FAMILY_FIELD_NUMBER: _ClassVar[int]
    MAX_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    vendor: str
    family: str
    max_input_tokens: int
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., vendor: _Optional[str] = ..., family: _Optional[str] = ..., max_input_tokens: _Optional[int] = ...) -> None: ...

class SendVSCodeChatRequest(_message.Message):
    __slots__ = ("model_id", "messages", "temperature", "max_tokens")
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    model_id: str
    messages: _containers.RepeatedCompositeFieldContainer[Message]
    temperature: float
    max_tokens: int
    def __init__(self, model_id: _Optional[str] = ..., messages: _Optional[_Iterable[_Union[Message, _Mapping]]] = ..., temperature: _Optional[float] = ..., max_tokens: _Optional[int] = ...) -> None: ...

class SendVSCodeChatResponse(_message.Message):
    __slots__ = ("chunks",)
    CHUNKS_FIELD_NUMBER: _ClassVar[int]
    chunks: _containers.RepeatedCompositeFieldContainer[VSCodeChatChunk]
    def __init__(self, chunks: _Optional[_Iterable[_Union[VSCodeChatChunk, _Mapping]]] = ...) -> None: ...

class VSCodeChatChunk(_message.Message):
    __slots__ = ("text", "tool_call")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    TOOL_CALL_FIELD_NUMBER: _ClassVar[int]
    text: str
    tool_call: VSCodeToolCall
    def __init__(self, text: _Optional[str] = ..., tool_call: _Optional[_Union[VSCodeToolCall, _Mapping]] = ...) -> None: ...

class VSCodeToolCall(_message.Message):
    __slots__ = ("call_id", "name", "arguments_json")
    CALL_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    call_id: str
    name: str
    arguments_json: str
    def __init__(self, call_id: _Optional[str] = ..., name: _Optional[str] = ..., arguments_json: _Optional[str] = ...) -> None: ...

class ListPoliciesRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListPoliciesResponse(_message.Message):
    __slots__ = ("policies",)
    POLICIES_FIELD_NUMBER: _ClassVar[int]
    policies: _containers.RepeatedCompositeFieldContainer[PolicyInfo]
    def __init__(self, policies: _Optional[_Iterable[_Union[PolicyInfo, _Mapping]]] = ...) -> None: ...

class PolicyInfo(_message.Message):
    __slots__ = ("name", "builtin", "config")
    NAME_FIELD_NUMBER: _ClassVar[int]
    BUILTIN_FIELD_NUMBER: _ClassVar[int]
    CONFIG_FIELD_NUMBER: _ClassVar[int]
    name: str
    builtin: bool
    config: PolicyConfig
    def __init__(self, name: _Optional[str] = ..., builtin: bool = ..., config: _Optional[_Union[PolicyConfig, _Mapping]] = ...) -> None: ...

class PolicyConfig(_message.Message):
    __slots__ = ("sampling", "output", "context", "tool", "reliability")
    SAMPLING_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_FIELD_NUMBER: _ClassVar[int]
    TOOL_FIELD_NUMBER: _ClassVar[int]
    RELIABILITY_FIELD_NUMBER: _ClassVar[int]
    sampling: PolicySampling
    output: PolicyOutput
    context: PolicyContext
    tool: PolicyTool
    reliability: PolicyReliability
    def __init__(self, sampling: _Optional[_Union[PolicySampling, _Mapping]] = ..., output: _Optional[_Union[PolicyOutput, _Mapping]] = ..., context: _Optional[_Union[PolicyContext, _Mapping]] = ..., tool: _Optional[_Union[PolicyTool, _Mapping]] = ..., reliability: _Optional[_Union[PolicyReliability, _Mapping]] = ...) -> None: ...

class PolicySampling(_message.Message):
    __slots__ = ("temperature", "top_p", "top_k")
    TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    TOP_P_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    temperature: float
    top_p: float
    top_k: int
    def __init__(self, temperature: _Optional[float] = ..., top_p: _Optional[float] = ..., top_k: _Optional[int] = ...) -> None: ...

class PolicyOutput(_message.Message):
    __slots__ = ("max_tokens", "reserved_output_tokens", "format", "system_prompt_snippet", "system_prompt_mode")
    MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    RESERVED_OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_PROMPT_SNIPPET_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_PROMPT_MODE_FIELD_NUMBER: _ClassVar[int]
    max_tokens: int
    reserved_output_tokens: int
    format: str
    system_prompt_snippet: str
    system_prompt_mode: str
    def __init__(self, max_tokens: _Optional[int] = ..., reserved_output_tokens: _Optional[int] = ..., format: _Optional[str] = ..., system_prompt_snippet: _Optional[str] = ..., system_prompt_mode: _Optional[str] = ...) -> None: ...

class PolicyContext(_message.Message):
    __slots__ = ("context_threshold", "compression_strategy")
    CONTEXT_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    COMPRESSION_STRATEGY_FIELD_NUMBER: _ClassVar[int]
    context_threshold: float
    compression_strategy: str
    def __init__(self, context_threshold: _Optional[float] = ..., compression_strategy: _Optional[str] = ...) -> None: ...

class PolicyTool(_message.Message):
    __slots__ = ("max_tool_iterations", "tool_mode")
    MAX_TOOL_ITERATIONS_FIELD_NUMBER: _ClassVar[int]
    TOOL_MODE_FIELD_NUMBER: _ClassVar[int]
    max_tool_iterations: int
    tool_mode: str
    def __init__(self, max_tool_iterations: _Optional[int] = ..., tool_mode: _Optional[str] = ...) -> None: ...

class PolicyReliability(_message.Message):
    __slots__ = ("retry_on_invalid_json", "timeout")
    RETRY_ON_INVALID_JSON_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_FIELD_NUMBER: _ClassVar[int]
    retry_on_invalid_json: bool
    timeout: int
    def __init__(self, retry_on_invalid_json: bool = ..., timeout: _Optional[int] = ...) -> None: ...

class RegisterMcpServerRequest(_message.Message):
    __slots__ = ("server_id", "transport", "capabilities")
    SERVER_ID_FIELD_NUMBER: _ClassVar[int]
    TRANSPORT_FIELD_NUMBER: _ClassVar[int]
    CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    server_id: str
    transport: str
    capabilities: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, server_id: _Optional[str] = ..., transport: _Optional[str] = ..., capabilities: _Optional[_Iterable[str]] = ...) -> None: ...

class UnregisterMcpServerRequest(_message.Message):
    __slots__ = ("server_id",)
    SERVER_ID_FIELD_NUMBER: _ClassVar[int]
    server_id: str
    def __init__(self, server_id: _Optional[str] = ...) -> None: ...
