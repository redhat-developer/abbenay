// ══════════════════════════════════════════════════════════════════════════════
// Abbenay Chat Sidebar UI — Copilot-style with markdown, tool cards, approvals
// ══════════════════════════════════════════════════════════════════════════════

import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-collapsible/index.js';
import '@vscode-elements/elements/dist/vscode-progress-ring/index.js';
import '@vscode-elements/elements/dist/vscode-badge/index.js';

import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';

// Register highlight.js languages
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);

// Register aliases
hljs.registerAliases('shell', { languageName: 'bash' });
hljs.registerAliases('yml', { languageName: 'yaml' });
hljs.registerAliases('html', { languageName: 'xml' });

// ── VS Code API ──────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

// ── Type Definitions ─────────────────────────────────────────────────────────

type ModelInfo = {
  id: string;
  provider: string;
  name: string;
  engine: string;
};

type SessionInfo = {
  id: string;
  model: string;
  topic: string;
  messageCount: number;
  createdAt?: string;
  updatedAt?: string;
};

type MessageInfo = {
  role: string;
  content: string;
  toolCalls?: {
    id: string;
    name: string;
    arguments: string;
  }[];
};

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  models: [] as ModelInfo[],
  sessions: [] as SessionInfo[],
  currentSessionId: null as string | null,
  currentModel: '',
  messages: [] as MessageInfo[],
  isStreaming: false,
  currentAssistantText: '',
  pendingToolCalls: new Map<string, { name: string; args: string; result?: string; isError?: boolean }>(),
  pendingApprovals: new Map<string, { toolName: string; args: string }>(),
  approvalWaiting: false,
  userScrolledUp: false,
};

// ── DOM References ───────────────────────────────────────────────────────────

let $modelSelect: HTMLElement & { value: string };
let $messageList: HTMLElement;
let $textarea: HTMLTextAreaElement;
let $sendBtn: HTMLButtonElement;
let $cancelBtn: HTMLButtonElement;

// ── Configure marked ─────────────────────────────────────────────────────────

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }: { text: string; lang?: string }): string {
  const language = lang || 'plaintext';
  let highlighted: string;

  try {
    if (hljs.getLanguage(language)) {
      highlighted = hljs.highlight(text, { language }).value;
    } else {
      highlighted = esc(text);
    }
  } catch {
    highlighted = esc(text);
  }

  const encodedCode = encodeURIComponent(text);

  return `
    <div class="code-block">
      <div class="code-block-header">
        <span class="code-block-language">${esc(language)}</span>
        <button class="code-block-copy" data-code="${encodedCode}">Copy</button>
      </div>
      <pre><code>${highlighted}</code></pre>
    </div>
  `;
};

renderer.html = function ({ text }: { text: string }): string {
  return esc(text);
};

marked.setOptions({
  renderer,
  breaks: true,
});

// ── Initialization ───────────────────────────────────────────────────────────

function init(): void {
  const root = document.getElementById('root')!;

  root.innerHTML = `
    <div id="messageList" class="message-list">
      <div class="welcome">
        <div class="welcome-icon">
          <svg width="36" height="36" viewBox="0 0 256 256">
            <circle cx="128" cy="128" r="128" fill="var(--vscode-descriptionForeground)" opacity="0.15"/>
            <path d="m130.46 78.23 33.01 81.48-49.86-39.28 16.85-42.2zm58.64 100.24-50.78-122.2c-1.45-3.52-4.35-5.39-7.87-5.39-3.52 0-6.63 1.87-8.08 5.39l-55.73 134.04h19.07l22.06-55.27 65.84 53.19c2.65 2.14 4.56 3.11 7.04 3.11 4.97 0 9.32-3.73 9.32-9.11 0-.88-.31-2.27-.87-3.76z" fill="var(--vscode-descriptionForeground)" opacity="0.6"/>
          </svg>
        </div>
        <h2>Abbenay Chat</h2>
        <p>Select a model and start a new chat to begin.</p>
      </div>
    </div>
    <div class="input-area">
      <div class="input-box">
        <textarea id="msgInput" placeholder="Ask Abbenay..." rows="1"></textarea>
        <div class="input-toolbar">
          <vscode-single-select id="modelSelect" class="toolbar-select" position="above">
            <vscode-option value="">Select model...</vscode-option>
          </vscode-single-select>
          <vscode-button id="newSessionBtn" secondary class="toolbar-btn" title="New session">+ New</vscode-button>
          <vscode-button id="deleteSessionBtn" secondary class="toolbar-btn" title="Delete session">&times;</vscode-button>
          <button id="sendBtn" class="send-btn" disabled title="Send (Enter)">&#9650;</button>
          <button id="cancelBtn" class="cancel-btn" style="display: none;" title="Cancel">&#9632;</button>
        </div>
      </div>
      <div class="input-hints">
        <span>Shift+Enter for newline</span>
        <span>Enter to send</span>
      </div>
    </div>
  `;

  $modelSelect = document.getElementById('modelSelect') as HTMLElement & { value: string };
  $messageList = document.getElementById('messageList') as HTMLElement;
  $textarea = document.getElementById('msgInput') as HTMLTextAreaElement;
  $sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
  $cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement;

  // Event listeners
  document.getElementById('newSessionBtn')!.addEventListener('click', handleNewSession);
  document.getElementById('deleteSessionBtn')!.addEventListener('click', handleDeleteSession);
  $modelSelect.addEventListener('change', () => {
    state.currentModel = $modelSelect.value;
  });
  $sendBtn.addEventListener('click', handleSend);
  $cancelBtn.addEventListener('click', handleCancel);
  $textarea.addEventListener('keydown', handleTextareaKeydown);
  $textarea.addEventListener('input', autoResize);
  $messageList.addEventListener('scroll', handleScroll);

  window.addEventListener('message', onMessage);
  api.postMessage({ type: 'ready' });
}

// ── Event Handlers ───────────────────────────────────────────────────────────

function handleNewSession(): void {
  if (!$modelSelect.value) {
    showError('Please select a model first');
    return;
  }
  api.postMessage({ type: 'createSession', model: $modelSelect.value, topic: 'New Chat' });
}

function handleDeleteSession(): void {
  if (!state.currentSessionId) {return;}
  api.postMessage({ type: 'deleteSession', sessionId: state.currentSessionId });
  state.currentSessionId = null;
  state.messages = [];
  state.currentAssistantText = '';
  state.pendingToolCalls.clear();
  state.pendingApprovals.clear();
  state.approvalWaiting = false;
  renderMessages();
  updateInputState();
}

function handleSend(): void {
  const text = $textarea.value.trim();
  if (!text || !state.currentSessionId || state.isStreaming || state.approvalWaiting) {
    return;
  }

  // Push user message
  state.messages.push({ role: 'user', content: text });
  appendMsg({ role: 'user', content: text });

  // Clear input
  $textarea.value = '';
  autoResize();

  // Set streaming state
  state.isStreaming = true;
  updateInputState();

  // Show thinking indicator
  showThinkingIndicator();

  // Send to host
  api.postMessage({
    type: 'sendMessage',
    sessionId: state.currentSessionId,
    content: text,
  });

  state.userScrolledUp = false;
  scrollToBottom();
}

function handleCancel(): void {
  api.postMessage({ type: 'cancelStream' });
  state.isStreaming = false;
  updateInputState();
  removeThinkingIndicator();
}

// Handle a prompt injected by the extension host.
function handleInjectPrompt(message: string): void {
  if (state.isStreaming || state.approvalWaiting) {
    $textarea.value = message;
    autoResize();
    $textarea.focus();
    return;
  }

  if (!state.currentSessionId) {
    const model = state.currentModel || state.models[0]?.id;
    if (!model) {
      $textarea.value = message;
      autoResize();
      $textarea.focus();
      return;
    }
    $modelSelect.value = model;
    state.currentModel = model;

    pendingInjectedPrompt = message;
    api.postMessage({ type: 'createSession', model, topic: 'New Chat' });
    return;
  }

  $textarea.value = message;
  autoResize();
  handleSend();
}

let pendingInjectedPrompt: string | null = null;

function handleTextareaKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function handleScroll(): void {
  const atBottom = $messageList.scrollHeight - $messageList.scrollTop - $messageList.clientHeight <= 30;
  state.userScrolledUp = !atBottom;
}

// ── Message Handler ──────────────────────────────────────────────────────────

function onMessage(event: MessageEvent): void {
  const msg = event.data;

  switch (msg.type) {
    case 'models':
      state.models = msg.models;
      renderModels();
      break;

    case 'sessions':
      state.sessions = msg.sessions;
      renderSessions();
      break;

    case 'sessionCreated':
      state.currentSessionId = msg.session.id;
      state.currentModel = msg.session.model;
      state.messages = [];
      state.currentAssistantText = '';
      state.pendingToolCalls.clear();
      state.pendingApprovals.clear();
      state.approvalWaiting = false;
      renderMessages();
      updateInputState();

      if (pendingInjectedPrompt) {
        const prompt = pendingInjectedPrompt;
        pendingInjectedPrompt = null;
        $textarea.value = prompt;
        autoResize();
        handleSend();
      } else {
        $textarea.focus();
      }
      break;

    case 'sessionLoaded':
      state.currentSessionId = msg.session.id;
      state.currentModel = msg.session.model;
      state.messages = msg.session.messages.filter((m: MessageInfo) => m.role !== 'system');
      state.currentAssistantText = '';
      state.pendingToolCalls.clear();
      state.pendingApprovals.clear();
      state.approvalWaiting = false;
      renderMessages();
      updateInputState();
      state.userScrolledUp = false;
      scrollToBottom();
      break;

    case 'streamChunk':
      removeThinkingIndicator();
      state.currentAssistantText += msg.text;
      updateStreamingMsg();
      break;

    case 'streamDone':
      removeThinkingIndicator();
      finalizeStream();
      state.isStreaming = false;
      updateInputState();
      break;

    case 'toolCall':
      removeThinkingIndicator();
      addToolCard(msg.id, msg.name, msg.args, true);
      break;

    case 'toolResult':
      updateToolCard(msg.callId, msg.content, msg.isError);
      break;

    case 'toolApprovalRequest':
      createApprovalGate(msg.requestId, msg.toolName, msg.promptText);
      state.pendingApprovals.set(msg.requestId, { toolName: msg.toolName, args: msg.promptText });
      state.approvalWaiting = true;
      updateInputState();
      state.userScrolledUp = false;
      scrollToBottom();
      break;

    case 'injectPrompt':
      handleInjectPrompt(msg.message);
      break;

    case 'error':
      removeThinkingIndicator();
      showError(msg.message, msg.context);
      state.isStreaming = false;
      updateInputState();
      break;
  }
}

// ── Render Functions ─────────────────────────────────────────────────────────

function renderModels(): void {
  const currentValue = $modelSelect.value;

  // Remove all options except the first placeholder
  const existingOptions = $modelSelect.querySelectorAll('vscode-option');
  existingOptions.forEach((opt, i) => {
    if (i > 0) {opt.remove();}
  });

  state.models.forEach((m) => {
    const opt = document.createElement('vscode-option') as HTMLElement;
    opt.setAttribute('value', m.id);
    opt.textContent = m.id;
    $modelSelect.appendChild(opt);
  });

  if (state.currentModel) {
    $modelSelect.value = state.currentModel;
  } else if (currentValue) {
    $modelSelect.value = currentValue;
  }
}

function renderSessions(): void {
  // Sessions dropdown removed per spec — sessions managed via API only
}

function renderMessages(): void {
  $messageList.innerHTML = '';

  if (state.messages.length === 0) {
    $messageList.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon">
          <svg width="36" height="36" viewBox="0 0 256 256">
            <circle cx="128" cy="128" r="128" fill="var(--vscode-descriptionForeground)" opacity="0.15"/>
            <path d="m130.46 78.23 33.01 81.48-49.86-39.28 16.85-42.2zm58.64 100.24-50.78-122.2c-1.45-3.52-4.35-5.39-7.87-5.39-3.52 0-6.63 1.87-8.08 5.39l-55.73 134.04h19.07l22.06-55.27 65.84 53.19c2.65 2.14 4.56 3.11 7.04 3.11 4.97 0 9.32-3.73 9.32-9.11 0-.88-.31-2.27-.87-3.76z" fill="var(--vscode-descriptionForeground)" opacity="0.6"/>
          </svg>
        </div>
        <h2>Abbenay Chat</h2>
        <p>${state.currentSessionId ? 'Ask anything below.' : 'Select a model and start a new chat.'}</p>
      </div>
    `;
    return;
  }

  state.messages.forEach((m) => appendMsg(m));
}

function appendMsg(msg: MessageInfo): void {
  const el = document.createElement('div');
  el.className = `message message-${msg.role}`;

  // Create content container
  const content = document.createElement('div');
  content.className = 'msg-content';

  // Add role label (assistant only)
  if (msg.role === 'assistant') {
    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = 'Abbenay';
    content.appendChild(role);
  }

  // Add body
  const body = document.createElement('div');
  body.className = 'msg-body';

  if (msg.role === 'user') {
    // User messages: plain text (no markdown)
    body.textContent = msg.content;
  } else {
    // Assistant messages: rendered markdown (marked.parse handles escaping)
    body.innerHTML = marked.parse(msg.content) as string;
    attachCopyListeners(body);
  }

  content.appendChild(body);

  // Add tool calls if present
  if (msg.toolCalls) {
    msg.toolCalls.forEach((tc) => {
      content.appendChild(createToolCard(tc.id, tc.name, tc.arguments, false));
    });
  }

  el.appendChild(content);
  $messageList.appendChild(el);
}

// ── Streaming Functions ──────────────────────────────────────────────────────

function updateStreamingMsg(): void {
  let el = $messageList.querySelector('.streaming') as HTMLElement;

  if (!el) {
    // Create streaming message
    state.messages.push({ role: 'assistant', content: '' });

    el = document.createElement('div');
    el.className = 'message message-assistant streaming';

    const content = document.createElement('div');
    content.className = 'msg-content';

    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = 'Abbenay';

    const body = document.createElement('div');
    body.className = 'msg-body';

    content.appendChild(role);
    content.appendChild(body);
    el.appendChild(content);
    $messageList.appendChild(el);
  }

  const body = el.querySelector('.msg-body') as HTMLElement;
  // Rendered markdown (marked.parse handles escaping)
  body.innerHTML = marked.parse(state.currentAssistantText) as string;
  attachCopyListeners(body);

  // Auto-scroll if user hasn't scrolled up
  if (!state.userScrolledUp) {
    scrollToBottom();
  }
}

function finalizeStream(): void {
  const el = $messageList.querySelector('.streaming') as HTMLElement;
  if (el) {
    el.classList.remove('streaming');
  }

  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'assistant') {
    last.content = state.currentAssistantText;
  }
  state.currentAssistantText = '';
}

// ── Thinking Indicator ───────────────────────────────────────────────────────

function showThinkingIndicator(): void {
  removeThinkingIndicator();

  const el = document.createElement('div');
  el.className = 'message thinking-indicator';
  el.id = 'thinkingIndicator';

  const content = document.createElement('div');
  content.className = 'msg-content';

  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Abbenay';

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';

  content.appendChild(role);
  content.appendChild(body);
  el.appendChild(content);
  $messageList.appendChild(el);

  if (!state.userScrolledUp) {
    scrollToBottom();
  }
}

function removeThinkingIndicator(): void {
  const el = document.getElementById('thinkingIndicator');
  if (el) {
    el.remove();
  }
}

// ── Tool Cards ───────────────────────────────────────────────────────────────

function addToolCard(id: string, name: string, args: string, isRunning: boolean): void {
  state.pendingToolCalls.set(id, { name, args });

  const lastMsg = $messageList.querySelector('.streaming .msg-content, .message:last-child .msg-content') as HTMLElement;
  if (lastMsg) {
    lastMsg.appendChild(createToolCard(id, name, args, isRunning));
  }
}

function createToolCard(id: string, name: string, args: string, isRunning: boolean): HTMLElement {
  const card = document.createElement('vscode-collapsible') as HTMLElement;
  card.className = 'tool-card';
  card.setAttribute('heading', name);
  card.setAttribute('description', isRunning ? 'Running' : 'Used');
  card.dataset.toolId = id;
  if (!isRunning) {card.setAttribute('open', '');}

  // Status indicator in decorations slot
  const status = document.createElement('span');
  status.slot = 'decorations';
  status.className = isRunning ? 'tool-card-status running' : 'tool-card-status';
  if (isRunning) {
    const ring = document.createElement('vscode-progress-ring') as HTMLElement;
    ring.style.width = '14px';
    ring.style.height = '14px';
    status.appendChild(ring);
  }
  card.appendChild(status);

  // Arguments section
  const argsSection = document.createElement('div');
  argsSection.className = 'tool-card-section';

  const argsLabel = document.createElement('div');
  argsLabel.className = 'tool-card-section-label';
  argsLabel.textContent = 'Arguments';

  const argsPre = document.createElement('pre');
  try {
    argsPre.textContent = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    argsPre.textContent = args;
  }

  argsSection.appendChild(argsLabel);
  argsSection.appendChild(argsPre);
  card.appendChild(argsSection);

  return card;
}

function updateToolCard(callId: string, content: string, isError: boolean): void {
  const tc = state.pendingToolCalls.get(callId);
  if (tc) {
    tc.result = content;
    tc.isError = isError;
  }

  const card = document.querySelector(`[data-tool-id="${callId}"]`) as HTMLElement;
  if (!card) {return;}

  // Update status icon in decorations slot
  const status = card.querySelector('.tool-card-status') as HTMLElement;
  if (status) {
    status.className = `tool-card-status ${isError ? 'error' : 'success'}`;
    status.innerHTML = isError ? '✗' : '✓';
  }

  // Update description
  card.setAttribute('description', 'Used');

  // Add result section
  const resultSection = document.createElement('div');
  resultSection.className = 'tool-card-section';

  const resultLabel = document.createElement('div');
  resultLabel.className = 'tool-card-section-label';
  resultLabel.textContent = 'Result';

  const resultPre = document.createElement('pre');
  resultPre.textContent = content;

  resultSection.appendChild(resultLabel);
  resultSection.appendChild(resultPre);
  card.appendChild(resultSection);

  // Collapse card
  card.removeAttribute('open');
}

// ── Approval Gates ───────────────────────────────────────────────────────────

function createApprovalGate(requestId: string, toolName: string, promptText: string): void {
  const gate = document.createElement('div');
  gate.className = 'approval-gate';
  gate.id = `approval-${requestId}`;

  const header = document.createElement('div');
  header.className = 'approval-gate-header';

  const icon = document.createElement('span');
  icon.className = 'approval-gate-icon';
  icon.textContent = '⚠';

  const title = document.createElement('span');
  title.className = 'approval-gate-title';
  title.textContent = 'Tool Approval Required';

  header.appendChild(icon);
  header.appendChild(title);

  const body = document.createElement('div');
  body.className = 'approval-gate-body';

  const nameEl = document.createElement('div');
  nameEl.className = 'approval-tool-name';
  nameEl.textContent = toolName;

  const argsDiv = document.createElement('div');
  argsDiv.className = 'approval-args';

  const argsPre = document.createElement('pre');
  try {
    argsPre.textContent = JSON.stringify(JSON.parse(promptText), null, 2);
  } catch {
    argsPre.textContent = promptText;
  }

  argsDiv.appendChild(argsPre);

  const buttons = document.createElement('div');
  buttons.className = 'approval-buttons';

  const allowBtn = document.createElement('vscode-button') as HTMLElement;
  allowBtn.textContent = 'Allow';
  allowBtn.addEventListener('click', () => {
    api.postMessage({ type: 'approveToolCall', requestId, decision: 'allow' });
    resolveApprovalGate(requestId, 'allow');
  });

  const denyBtn = document.createElement('vscode-button') as HTMLElement;
  denyBtn.setAttribute('secondary', '');
  denyBtn.textContent = 'Deny';
  denyBtn.addEventListener('click', () => {
    api.postMessage({ type: 'approveToolCall', requestId, decision: 'deny' });
    resolveApprovalGate(requestId, 'deny');
  });

  const abortBtn = document.createElement('vscode-button') as HTMLElement;
  abortBtn.setAttribute('secondary', '');
  abortBtn.className = 'approval-btn-abort';
  abortBtn.textContent = 'Abort';
  abortBtn.addEventListener('click', () => {
    api.postMessage({ type: 'approveToolCall', requestId, decision: 'abort' });
    resolveApprovalGate(requestId, 'abort');
  });

  buttons.appendChild(allowBtn);
  buttons.appendChild(denyBtn);
  buttons.appendChild(abortBtn);

  body.appendChild(nameEl);
  body.appendChild(argsDiv);
  body.appendChild(buttons);

  gate.appendChild(header);
  gate.appendChild(body);

  const lastMsg = $messageList.querySelector('.streaming .msg-content, .message:last-child .msg-content') as HTMLElement;
  if (lastMsg) {
    lastMsg.appendChild(gate);
  } else {
    $messageList.appendChild(gate);
  }
}

function resolveApprovalGate(requestId: string, decision: 'allow' | 'deny' | 'abort'): void {
  const gate = document.getElementById(`approval-${requestId}`) as HTMLElement;
  if (!gate) {return;}

  gate.classList.add('resolved');
  gate.innerHTML = '';

  const resolved = document.createElement('div');
  resolved.className = `approval-resolved ${decision === 'allow' ? 'allowed' : decision === 'deny' ? 'denied' : 'aborted'}`;

  if (decision === 'allow') {
    resolved.textContent = '✓ Allowed';
  } else if (decision === 'deny') {
    resolved.textContent = '✗ Denied';
  } else {
    resolved.textContent = '✗ Aborted';
  }

  gate.appendChild(resolved);

  state.pendingApprovals.delete(requestId);
  if (state.pendingApprovals.size === 0) {
    state.approvalWaiting = false;
    updateInputState();
  }
}

// ── Error Display ────────────────────────────────────────────────────────────

function showError(message: string, context?: string): void {
  const el = document.createElement('div');
  el.className = 'message message-error';

  const content = document.createElement('div');
  content.className = 'msg-content';

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = context ? `${context}: ${message}` : message;

  content.appendChild(body);
  el.appendChild(content);
  $messageList.appendChild(el);

  if (!state.userScrolledUp) {
    scrollToBottom();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function updateInputState(): void {
  const canSend = !state.isStreaming && !state.approvalWaiting && state.currentSessionId !== null;

  $sendBtn.disabled = !canSend;
  $textarea.disabled = state.isStreaming || state.approvalWaiting;

  if (state.approvalWaiting) {
    $textarea.placeholder = 'Waiting for approval...';
  } else {
    $textarea.placeholder = 'Ask Abbenay...';
  }

  // Toggle send/cancel buttons
  if (state.isStreaming) {
    $sendBtn.style.display = 'none';
    $cancelBtn.style.display = 'flex';
  } else {
    $sendBtn.style.display = 'flex';
    $cancelBtn.style.display = 'none';
  }
}

function scrollToBottom(): void {
  if (!state.userScrolledUp) {
    $messageList.scrollTop = $messageList.scrollHeight;
  }
}

function autoResize(): void {
  $textarea.style.height = 'auto';
  const newHeight = Math.min(Math.max($textarea.scrollHeight, 40), 200);
  $textarea.style.height = `${newHeight}px`;
}

function attachCopyListeners(container: HTMLElement): void {
  const copyButtons = container.querySelectorAll('.code-block-copy');
  copyButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = decodeURIComponent((btn as HTMLElement).dataset.code || '');
      navigator.clipboard.writeText(code).then(() => {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      });
    });
  });
}

function esc(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
