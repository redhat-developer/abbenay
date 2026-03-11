import * as vscode from 'vscode';
import { DaemonClient } from '../daemon/client';
import * as proto from '../proto/abbenay/v1/service';
import { getLogger } from '../utils/logger';

const logger = getLogger();

/** Single vendor ID used in package.json */
const VENDOR_ID = 'abbenay';

/**
 * Format the `detail` field for a model in the VS Code picker.
 * Shows engine type and any non-default parameters.
 * 
 * Example: "OpenRouter · temp=0.2, top_p=0.5"
 */
function formatDetail(model: proto.Model): string {
    const parts: string[] = [];
    
    // Provider name (virtual provider ID, e.g., "anthropic-test") with engine in parens
    const provider = model.provider || '';
    const engine = model.engine || '';
    if (provider && engine && provider !== engine) {
        parts.push(`${provider} (${engine})`);
    } else if (provider) {
        parts.push(provider);
    } else if (engine) {
        parts.push(engine);
    }
    
    // Non-default params
    const params = model.params;
    if (params) {
        const paramParts: string[] = [];
        if (params.temperature != null) paramParts.push(`temp=${params.temperature}`);
        if (params.topP != null) paramParts.push(`top_p=${params.topP}`);
        if (params.topK != null) paramParts.push(`top_k=${params.topK}`);
        if (params.maxTokens != null) paramParts.push(`max=${params.maxTokens}`);
        if (params.systemPrompt) paramParts.push('sys_prompt');
        if (paramParts.length > 0) {
            parts.push(paramParts.join(', '));
        }
    }
    
    if (parts.length === 0) return 'default';
    if (parts.length === 1 && (parts[0] === provider || parts[0] === engine || parts[0].startsWith(provider))) return `${parts[0]} · default`;
    return parts.join(' · ');
}

/**
 * Format a detailed tooltip for hover.
 */
function formatTooltip(model: proto.Model): string {
    const lines: string[] = [];
    lines.push(`Provider: ${model.provider || 'unknown'}`);
    lines.push(`Engine: ${model.engine || 'unknown'}`);
    lines.push(`Engine Model ID: ${model.engineModelId || model.name || model.id}`);
    if (model.capabilities?.contextWindow) {
        lines.push(`Context Window: ${model.capabilities.contextWindow.toLocaleString()}`);
    }
    const params = model.params;
    if (params) {
        if (params.temperature != null) lines.push(`Temperature: ${params.temperature}`);
        if (params.topP != null) lines.push(`Top P: ${params.topP}`);
        if (params.topK != null) lines.push(`Top K: ${params.topK}`);
        if (params.maxTokens != null) lines.push(`Max Tokens: ${params.maxTokens}`);
        if (params.timeout != null) lines.push(`Timeout: ${params.timeout}ms`);
        if (params.systemPrompt) lines.push(`System Prompt: ${params.systemPrompt.substring(0, 50)}...`);
    }
    return lines.join('\n');
}

/**
 * Single handler for the `abbenay` vendor.
 * All virtual models from all virtual providers are served through this one handler.
 * The `family` field provides grouping by virtual provider in the picker.
 */
class AbbenayHandler implements vscode.LanguageModelChatProvider {
    constructor(
        private readonly models: proto.Model[],
        private readonly client: DaemonClient,
    ) {}

    async provideLanguageModelChatInformation(
        _options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        logger.info(`[LMProvider] provideLanguageModelChatInformation called (${this.models.length} models)`);
        const result = this.models.map(model => {
            const compositeId = model.id || `${model.provider}/${model.name}`;
            // compositeId is already "{provider}/{bare-model}" (e.g., "anthropic-test/claude-opus-4-6")
            // Use it directly as the display name
            const provider = model.provider || '';
            const contextWindow = model.capabilities?.contextWindow || 128000;

            const info = {
                id: compositeId,                              // Routing key: "anthropic-test/claude-opus-4-6"
                name: compositeId,                            // Display: "anthropic-test/claude-opus-4-6"
                family: provider || 'abbenay',                // Grouping (not prominent in picker)
                detail: formatDetail(model),                  // "anthropic-test (anthropic) · default"
                tooltip: formatTooltip(model),                // Full details on hover
                version: '1.0.0',
                maxInputTokens: contextWindow,
                maxOutputTokens: Math.floor(contextWindow / 4),
                capabilities: {
                    imageInput: model.capabilities?.supportsVision || false,
                    toolCalling: model.capabilities?.supportsTools || false,
                },
            };
            logger.info(`[LMProvider]   → id="${info.id}" name="${info.name}" family="${info.family}" detail="${info.detail}"`);
            return info;
        });
        return result;
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Use the composite ID for routing to the daemon
        const compositeId = model.id;
        logger.debug(`[LMProvider] Chat request for model: ${compositeId}`);

        const protoMessages = convertMessages(messages);

        // Convert VS Code tool definitions to proto Tool format
        const protoTools: proto.DeepPartial<proto.Tool>[] = [];
        if (options.tools && options.tools.length > 0) {
            for (const tool of options.tools) {
                protoTools.push({
                    name: tool.name,
                    description: tool.description || '',
                    inputSchema: JSON.stringify(tool.inputSchema || {}),
                });
            }
            logger.debug(`[LMProvider] Forwarding ${protoTools.length} tools to daemon`);
        }

        // Determine tool mode:
        // - When VS Code provides tools, use 'auto' (daemon owns the loop via Vercel AI SDK)
        // - If toolMode is explicitly set in options, map it; otherwise infer from tools presence
        let toolMode = protoTools.length > 0 ? 'auto' : 'none';
        if (options.toolMode !== undefined) {
            // VS Code LanguageModelChatToolMode enum: Required=1
            // Map any non-undefined toolMode to 'auto' since VS Code only sends tools it wants used
            toolMode = 'auto';
        }

        const request: proto.DeepPartial<proto.ChatRequest> = {
            model: compositeId,
            messages: protoMessages,
            options: {
                temperature: options.modelOptions?.temperature as number | undefined,
                maxTokens: options.modelOptions?.maxTokens as number | undefined,
                toolMode: toolMode,
            },
            tools: protoTools.length > 0 ? protoTools : [],
        };

        const stream = this.client.chat(request);

        token.onCancellationRequested(() => {
            logger.debug(`[LMProvider] Request cancelled for ${compositeId}`);
        });

        try {
            for await (const chunk of stream) {
                if (token.isCancellationRequested) break;

                const c = chunk.chunk;
                if (!c) continue;

                switch (c.$case) {
                    case 'text': {
                        const text = c.text.text || '';
                        progress.report(new vscode.LanguageModelTextPart(text));
                        break;
                    }
                    case 'toolCall': {
                        // Tool call from the LLM (passthrough mode or before execution)
                        const tc = c.toolCall;
                        logger.debug(`[LMProvider] Tool call: ${tc.name} (id: ${tc.id})`);
                        progress.report(new vscode.LanguageModelToolCallPart(
                            tc.id || `call_${Date.now()}`,
                            tc.name || '',
                            JSON.parse(tc.arguments || '{}')
                        ));
                        break;
                    }
                    case 'toolResult': {
                        // Tool result from daemon execution (auto mode)
                        const tr = c.toolResult;
                        logger.debug(`[LMProvider] Tool result: ${tr.name} (callId: ${tr.toolCallId}, error: ${tr.isError})`);
                        // VS Code expects LanguageModelToolResultPart for tool results
                        progress.report(new vscode.LanguageModelToolResultPart(
                            tr.toolCallId || '',
                            [new vscode.LanguageModelTextPart(tr.content || '')]
                        ));
                        break;
                    }
                    case 'usage':
                        logger.debug(`[LMProvider] Usage: ${JSON.stringify(c.usage)}`);
                        break;
                    case 'error': {
                        const errMsg = c.error.message || 'Unknown error';
                        logger.error(`[LMProvider] Error chunk: ${errMsg}`);
                        // Surface the error as visible text in the chat response
                        progress.report(new vscode.LanguageModelTextPart(`\n\n**Error:** ${errMsg}\n`));
                        break;
                    }
                    case 'done':
                        logger.debug(`[LMProvider] Done: ${c.done.finishReason}`);
                        break;
                }
            }
        } catch (e) {
            if (!token.isCancellationRequested) {
                logger.error('[LMProvider] Chat error:', e);
                throw e;
            }
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        let totalChars = 0;
        if (typeof text === 'string') {
            totalChars = text.length;
        } else {
            for (const part of text.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    totalChars += part.value.length;
                }
            }
        }
        return Math.ceil(totalChars / 4);
    }
}

/**
 * Manages the single `abbenay` Language Model registration with VS Code.
 * 
 * All virtual models across all virtual providers are served through one vendor.
 * The `family` field on each model provides visual grouping by virtual provider
 * in the VS Code picker (e.g., "work-openrouter: claude-opus-precise").
 * 
 * Model refresh is driven by backchannel push notifications from the daemon.
 */
export class AbbenayLanguageModelProvider {
    private handler: AbbenayHandler | null = null;
    private disposable: vscode.Disposable | null = null;

    constructor(private client: DaemonClient) {}

    /**
     * Start the provider - fetches models and registers the single vendor.
     */
    async start(): Promise<void> {
        logger.info('[LMProvider] Starting Abbenay Language Model Provider (single vendor)');
        await this.refreshModels();
        logger.info('[LMProvider] Language Model Provider started');
    }

    /**
     * Stop the provider and clean up registration
     */
    stop(): void {
        logger.info('[LMProvider] Stopping Abbenay Language Model Provider');
        if (this.disposable) {
            this.disposable.dispose();
            this.disposable = null;
        }
        this.handler = null;
    }

    /**
     * Refresh the list of models from the daemon and update the registration.
     * Called on startup and whenever the daemon sends a ModelsChanged notification.
     * 
     * Always disposes and re-registers to force VS Code to re-call
     * provideLanguageModelChatInformation and pick up changes.
     */
    async refreshModels(): Promise<void> {
        try {
            const allModels = await this.client.listModels();
            logger.info(`[LMProvider] Fetched ${allModels.length} models from daemon`);

            // Log each model for debugging
            for (const m of allModels) {
                logger.info(`[LMProvider]   model: id=${m.id}, name=${m.name}, provider=${m.provider}, engine=${m.engine}`);
            }

            // Always dispose + re-register so VS Code picks up the new model list
            if (this.disposable) {
                this.disposable.dispose();
                this.disposable = null;
            }
            this.handler = new AbbenayHandler(allModels, this.client);
            this.disposable = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, this.handler);
            logger.info(`[LMProvider] Registered vendor: ${VENDOR_ID} (${allModels.length} models)`);

            // Log summary by family (virtual provider)
            const byFamily = new Map<string, number>();
            for (const m of allModels) {
                const family = m.provider || 'unknown';
                byFamily.set(family, (byFamily.get(family) || 0) + 1);
            }
            const summary = Array.from(byFamily.entries())
                .map(([f, c]) => `${f}(${c})`)
                .join(', ');
            logger.info(`[LMProvider] Models by provider: ${summary || 'none'}`);
        } catch (e) {
            logger.error('[LMProvider] Failed to list models:', e);
        }
    }
}

/**
 * Convert VS Code messages to proto format.
 * 
 * Handles:
 * - Text parts → concatenated into content string
 * - ToolCallPart → tool_calls array on assistant messages
 * - ToolResultPart → role=ROLE_TOOL with tool_call_id and result content
 */
function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): proto.Message[] {
    return messages.map(m => {
        let role: proto.Role;
        if (m.role === vscode.LanguageModelChatMessageRole.User) {
            role = proto.Role.ROLE_USER;
        } else if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
            role = proto.Role.ROLE_ASSISTANT;
        } else {
            role = proto.Role.ROLE_USER;
        }

        let textContent = '';
        const toolCalls: proto.DeepPartial<proto.ToolCall>[] = [];
        let toolCallId = '';

        for (const part of m.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textContent += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                // Assistant message with tool calls
                toolCalls.push({
                    id: part.callId || '',
                    name: part.name || '',
                    arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {}),
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                // Tool result message
                role = proto.Role.ROLE_TOOL;
                toolCallId = part.callId || '';
                // Extract text content from the result parts
                for (const resultPart of part.content) {
                    if (resultPart instanceof vscode.LanguageModelTextPart) {
                        textContent += resultPart.value;
                    }
                }
            }
        }

        return {
            role,
            content: textContent,
            toolCalls: toolCalls as proto.ToolCall[],
            toolCallId,
            name: m.name || '',
        };
    });
}
