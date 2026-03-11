/**
 * VS Code Backchannel - Bidirectional gRPC stream for daemon callbacks
 * 
 * This module handles requests from the daemon to:
 * - Invoke VS Code tools (vscode.lm.tools)
 * - List/use VS Code LM models (Copilot, etc.)
 * - Access VS Code secrets
 * 
 * The backchannel is a long-lived bidirectional stream. VS Code opens the stream,
 * and the daemon pushes requests through it. VS Code sends responses back.
 */

import * as vscode from 'vscode';
import { getLogger } from '../utils/logger';
import * as proto from '../proto/abbenay/v1/service';
import { DaemonClient } from './client';

const logger = getLogger();

// Our vendor ID prefix for filtering out our own models (avoid circular calls).
// All our per-provider vendors start with 'abbenay-' (e.g. abbenay-openrouter).
const OUR_VENDOR_PREFIX = 'abbenay-';

/**
 * Recursively extract plain text from a VS Code PromptTsx tree node.
 *
 * PromptTsx parts have a tree structure like:
 *   { node: { children: [ { text: "...", children: [...] }, ... ] } }
 * Leaf nodes carry a `text` string property. We walk the tree depth-first
 * and concatenate all text values.
 */
function extractTextFromPromptTsx(obj: unknown): string {
    if (obj == null) {return '';}
    if (typeof obj === 'string') {return obj;}

    const parts: string[] = [];
    const o = obj as Record<string, unknown>;

    if (typeof o.text === 'string') {
        if (o.lineBreakBefore) {parts.push('\n');}
        parts.push(o.text);
    }

    if (o.node != null) {
        const inner = extractTextFromPromptTsx(o.node);
        if (inner) {parts.push(inner);}
    }

    if (Array.isArray(o.children)) {
        for (const child of o.children) {
            const inner = extractTextFromPromptTsx(child);
            if (inner) {parts.push(inner);}
        }
    }

    if (parts.length === 0 && o.value != null) {
        if (typeof o.value === 'string') {return o.value;}
        return extractTextFromPromptTsx(o.value);
    }

    return parts.join('');
}

/**
 * VS Code Backchannel Handler
 * 
 * Manages the bidirectional stream with the daemon for callbacks.
 */
export class BackchannelHandler {
    private client: DaemonClient;
    private context: vscode.ExtensionContext;
    private stream: AsyncGenerator<proto.VSCodeRequest, void, proto.VSCodeResponse> | null = null;
    private running = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    
    // Cache of VS Code LM models
    private modelCache: Map<string, vscode.LanguageModelChat> = new Map();
    
    // Callback to send unsolicited notifications through the stream
    private sendNotification: ((response: proto.VSCodeResponse) => void) | null = null;

    /** Callback fired when daemon sends a ModelsChanged notification */
    onModelsChanged: (() => void) | null = null;

    constructor(client: DaemonClient, context: vscode.ExtensionContext) {
        this.client = client;
        this.context = context;
    }

    /**
     * Start the backchannel stream
     */
    async start(): Promise<void> {
        if (this.running) {
            return;
        }
        
        this.running = true;
        await this.connect();
    }

    /**
     * Stop the backchannel stream
     */
    async stop(): Promise<void> {
        this.running = false;
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // Stream will be closed when we stop reading
        this.stream = null;
    }

    /**
     * Connect to the daemon's backchannel
     */
    private async connect(): Promise<void> {
        if (!this.running) {
            return;
        }

        try {
            logger.info('[Backchannel] Connecting to daemon...');
            
            const grpcClient = this.client.getClient();
            
            // Open bidirectional stream
            // Note: nice-grpc uses AsyncGenerator for bidi streams
            // We need to handle this with the nice-grpc client pattern
            await this.runBackchannelLoop(grpcClient);
            
        } catch (error) {
            logger.error('[Backchannel] Connection error:', error);
            this.scheduleReconnect();
        }
    }

    /**
     * Run the backchannel message loop
     */
    private async runBackchannelLoop(grpcClient: proto.AbbenayClient): Promise<void> {
        try {
            // For nice-grpc bidirectional streams, we create an async generator
            // that yields our responses, and iterate over the requests
            const responseQueue: proto.VSCodeResponse[] = [];
            let resolveNext: ((value: proto.VSCodeResponse) => void) | null = null;
            
            // Create an async generator for our responses
            async function* responseGenerator(): AsyncGenerator<proto.DeepPartial<proto.VSCodeResponse>> {
                while (true) {
                    if (responseQueue.length > 0) {
                        yield responseQueue.shift()!;
                    } else {
                        // Wait for next response
                        const response = await new Promise<proto.VSCodeResponse>(resolve => {
                            resolveNext = resolve;
                        });
                        resolveNext = null;
                        yield response;
                    }
                }
            }

            // Helper to send a response
            const sendResponse = (response: proto.VSCodeResponse) => {
                if (resolveNext) {
                    resolveNext(response);
                } else {
                    responseQueue.push(response);
                }
            };

            // Wire the notification sender so pushToolUpdate() can send on the stream
            this.sendNotification = sendResponse;

            // Open the bidirectional stream
            const requestStream = grpcClient.vSCodeStream(responseGenerator());
            
            logger.info('[Backchannel] Stream opened, listening for requests...');
            
            // Process requests from daemon
            for await (const request of requestStream) {
                if (!this.running) {
                    break;
                }
                
                try {
                    const response = await this.handleRequest(request);
                    sendResponse(response);
                } catch (error) {
                    logger.error('[Backchannel] Error handling request:', error);
                    sendResponse({
                        requestId: request.requestId,
                        response: { $case: 'error' as const, error: {
                            message: error instanceof Error ? error.message : String(error),
                            code: 'INTERNAL_ERROR',
                        }},
                    });
                }
            }
            
            logger.info('[Backchannel] Stream closed');
            this.sendNotification = null;
            
        } catch (error) {
            this.sendNotification = null;
            throw error;
        }
    }

    /**
     * Handle a request from the daemon
     */
    private async handleRequest(request: proto.VSCodeRequest): Promise<proto.VSCodeResponse> {
        const oneof = request.request;
        const requestCase = oneof?.$case ?? '';
        
        logger.info(`[Backchannel] Handling request: ${request.requestId} ($case=${requestCase})`);
        
        switch (requestCase) {
            case 'invokeTool':
                return this.handleInvokeTool(request.requestId, oneof.invokeTool!);
            case 'listModels':
                return this.handleListModels(request.requestId, oneof.listModels!);
            case 'sendChat':
                return this.handleSendChat(request.requestId, oneof.sendChat!);
            case 'getWorkspace':
                return this.handleGetWorkspace(request.requestId);
            case 'listTools':
                return this.handleListTools(request.requestId);
            case 'modelsChanged': {
                const reason = oneof.modelsChanged?.reason ?? 'unknown';
                logger.info(`[Backchannel] Models changed notification received (reason: ${reason})`);
                if (this.onModelsChanged) {
                    this.onModelsChanged();
                }
                return { requestId: request.requestId };
            }
            default:
                logger.warn(`[Backchannel] Unknown request type: $case=${requestCase}, keys=${JSON.stringify(Object.keys(request))}`);
                return {
                    requestId: request.requestId,
                    response: { $case: 'error' as const, error: { message: `Unknown request type: ${requestCase}`, code: 'INVALID_REQUEST' } },
                };
        }
    }

    /**
     * Handle tool invocation request
     */
    private async handleInvokeTool(
        requestId: string,
        req: proto.InvokeToolRequest
    ): Promise<proto.VSCodeResponse> {
        logger.info(`[Backchannel] Invoking tool: ${req.toolName}`);
        
        try {
            const args = JSON.parse(req.argumentsJson || '{}') as Record<string, unknown>;
            
            const result = await vscode.lm.invokeTool(req.toolName, {
                input: args,
                toolInvocationToken: undefined,
            }, new vscode.CancellationTokenSource().token);

            // Extract text content from the tool result.
            // VS Code tool results contain LanguageModelTextPart (plain string)
            // and LanguageModelPromptTsxPart (tree of text nodes). We need to
            // recursively walk PromptTsx trees to extract the actual text.
            const textParts: string[] = [];
            for (const part of result.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else {
                    const raw = part as { value?: unknown };
                    const extracted = extractTextFromPromptTsx(raw.value ?? raw);
                    if (extracted) {
                        textParts.push(extracted);
                    }
                }
            }
            const resultText = textParts.join('\n');
            logger.info(`[Backchannel] Tool result: ${resultText.length} chars, preview: ${resultText.substring(0, 200)}`);

            return {
                requestId,
                response: { $case: 'invokeTool' as const, invokeTool: {
                    resultJson: resultText,
                    isError: false,
                }},
            };
        } catch (error) {
            return {
                requestId,
                response: { $case: 'invokeTool' as const, invokeTool: {
                    resultJson: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                    isError: true,
                }},
            };
        }
    }

    /**
     * Handle list models request
     */
    private async handleListModels(
        requestId: string,
        req: proto.ListVSCodeModelsRequest
    ): Promise<proto.VSCodeResponse> {
        logger.info('[Backchannel] Listing VS Code models');
        
        try {
            const selector: vscode.LanguageModelChatSelector = {};
            if (req.familyFilter) {
                selector.family = req.familyFilter;
            }

            const models = await vscode.lm.selectChatModels(selector);
            
            // Filter out our own models to avoid circular calls
            const externalModels = models.filter(m => !m.vendor.startsWith(OUR_VENDOR_PREFIX));
            
            // Cache models for later use
            for (const model of externalModels) {
                this.modelCache.set(model.id, model);
            }

            return {
                requestId,
                response: { $case: 'listModels' as const, listModels: {
                    models: externalModels.map(m => ({
                        id: m.id,
                        name: m.name,
                        vendor: m.vendor,
                        family: m.family,
                        maxInputTokens: m.maxInputTokens,
                    })),
                }},
            };
        } catch (error) {
            return {
                requestId,
                response: { $case: 'error' as const, error: { message: error instanceof Error ? error.message : String(error), code: 'LIST_MODELS_ERROR' }},
            };
        }
    }

    /**
     * Handle send chat request (to Copilot or other VS Code models)
     */
    private async handleSendChat(
        requestId: string,
        req: proto.SendVSCodeChatRequest
    ): Promise<proto.VSCodeResponse> {
        logger.info(`[Backchannel] Sending chat to model: ${req.modelId}`);
        
        try {
            // Get the model from cache or fetch it
            let model = this.modelCache.get(req.modelId);
            if (!model) {
                const models = await vscode.lm.selectChatModels({});
                model = models.find(m => m.id === req.modelId && !m.vendor.startsWith(OUR_VENDOR_PREFIX));
                if (model) {
                    this.modelCache.set(model.id, model);
                }
            }

            if (!model) {
                return {
                    requestId,
                    response: { $case: 'error' as const, error: { message: `Model not found: ${req.modelId}`, code: 'MODEL_NOT_FOUND' }},
                };
            }

            // Convert messages to VS Code format
            const vsMessages = req.messages.map(m => {
                switch (m.role) {
                    case proto.Role.ROLE_SYSTEM:
                    case proto.Role.ROLE_USER:
                        return vscode.LanguageModelChatMessage.User(m.content || '');
                    case proto.Role.ROLE_ASSISTANT:
                        return vscode.LanguageModelChatMessage.Assistant(m.content || '');
                    default:
                        return vscode.LanguageModelChatMessage.User(m.content || '');
                }
            });

            // Send request
            const response = await model.sendRequest(
                vsMessages,
                {},
                new vscode.CancellationTokenSource().token
            );

            const chunks: proto.VSCodeChatChunk[] = [];
            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    chunks.push({ chunk: { $case: 'text' as const, text: part.value } });
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    chunks.push({ chunk: { $case: 'toolCall' as const, toolCall: {
                        callId: part.callId,
                        name: part.name,
                        argumentsJson: JSON.stringify(part.input),
                    }}});
                }
            }

            return {
                requestId,
                response: { $case: 'sendChat' as const, sendChat: { chunks } },
            };
        } catch (error) {
            return {
                requestId,
                response: { $case: 'error' as const, error: { message: error instanceof Error ? error.message : String(error), code: 'CHAT_ERROR' }},
            };
        }
    }

    /**
     * Handle get workspace request
     */
    private async handleGetWorkspace(requestId: string): Promise<proto.VSCodeResponse> {
        logger.debug('[Backchannel] Getting workspace path');
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspacePath = workspaceFolders && workspaceFolders.length > 0 
            ? workspaceFolders[0].uri.fsPath 
            : '';
        const allFolders = workspaceFolders 
            ? workspaceFolders.map(f => f.uri.fsPath)
            : [];

        return {
            requestId,
            response: { $case: 'getWorkspace' as const, getWorkspace: {
                workspacePath,
                workspaceFolders: allFolders,
            }},
        };
    }

    /**
     * Handle list tools request — return all available VS Code tools
     */
    private async handleListTools(requestId: string): Promise<proto.VSCodeResponse> {
        logger.info('[Backchannel] Listing VS Code tools');
        
        try {
            const tools = vscode.lm.tools;
            const toolInfos = tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: JSON.stringify(t.inputSchema || {}),
                tags: t.tags || [],
            }));

            logger.info(`[Backchannel] Found ${toolInfos.length} VS Code tools`);
            
            return {
                requestId,
                response: { $case: 'listTools' as const, listTools: { tools: toolInfos } },
            };
        } catch (error) {
            return {
                requestId,
                response: { $case: 'error' as const, error: {
                    message: error instanceof Error ? error.message : String(error),
                    code: 'LIST_TOOLS_ERROR',
                }},
            };
        }
    }

    /**
     * Push tool updates to the daemon when VS Code tools change.
     * Call this from the extension activation to set up the listener.
     * Returns a disposable if the API is available, or a no-op disposable otherwise.
     */
    setupToolChangeListener(): vscode.Disposable {
        // onDidChangeTools may not be available in all VS Code versions
        interface LmWithOnDidChangeTools {
            onDidChangeTools?: (listener: () => void) => vscode.Disposable;
        }
        const lm = vscode.lm as LmWithOnDidChangeTools;
        if (typeof lm.onDidChangeTools === 'function') {
            return lm.onDidChangeTools(() => {
                logger.info('[Backchannel] VS Code tools changed, pushing update to daemon');
                this.pushToolUpdate();
            });
        }
        logger.info('[Backchannel] vscode.lm.onDidChangeTools not available, skipping change listener');
        return { dispose: () => {} };
    }

    /**
     * Send an unsolicited RegisterTools notification to the daemon
     * with the current set of VS Code tools.
     */
    private pushToolUpdate(): void {
        try {
            const tools = vscode.lm.tools;
            const toolInfos = tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: JSON.stringify(t.inputSchema || {}),
                tags: t.tags || [],
            }));

            // Send as an unsolicited response on the backchannel
            const notification: proto.VSCodeResponse = {
                requestId: `tools-update-${Date.now()}`,
                response: { $case: 'registerTools' as const, registerTools: { tools: toolInfos } },
            };

            // Queue the notification to be sent through the stream
            if (this.sendNotification) {
                this.sendNotification(notification);
                logger.info(`[Backchannel] Pushed ${toolInfos.length} tools to daemon`);
            }
        } catch (error) {
            logger.error('[Backchannel] Failed to push tool update:', error);
        }
    }

    /**
     * Schedule a reconnection attempt
     */
    private scheduleReconnect(): void {
        if (!this.running || this.reconnectTimer) {
            return;
        }

        logger.info('[Backchannel] Scheduling reconnect in 5 seconds...');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }
}
