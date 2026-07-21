import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-form-group/index.js';
import '@vscode-elements/elements/dist/vscode-label/index.js';
import '@vscode-elements/elements/dist/vscode-form-helper/index.js';
import '@vscode-elements/elements/dist/vscode-radio-group/index.js';
import '@vscode-elements/elements/dist/vscode-radio/index.js';
import '@vscode-elements/elements/dist/vscode-badge/index.js';
import '@vscode-elements/elements/dist/vscode-progress-ring/index.js';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// ─── Interfaces (local redeclaration for browser bundle) ────────────

interface ProviderInfo {
  id: string;
  engine: string;
  configured: boolean;
  healthy: boolean;
  requiresKey: boolean;
  baseUrl?: string;
  modelCount: number;
}

interface EngineInfo {
  id: string;
  displayName?: string;
  requiresKey: boolean;
  defaultBaseUrl?: string;
  defaultEnvVar?: string;
}

interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  engine: string;
}

// ─── State ───────────────────────────────────────────────────────────

const vsCodeApi = acquireVsCodeApi();

let providers: ProviderInfo[] = [];
let engines: EngineInfo[] = [];
let discoveredModels: ModelInfo[] = [];

const selectedModels: Map<string, string> = new Map();
const leftSelected: Set<string> = new Set();
const rightSelected: Set<string> = new Set();
let editingProviderId: string | null = null;

let section1Open = true;
let section2Open = false;
let selectedEngineId = '';

let providerName = '';
let apiKeyMethod: 'keychain' | 'env' = 'keychain';
let isDiscovering = false;
let discoverError: string | null = null;
let modelFilter = '';
let pendingEditModels: Record<string, { model_id?: string }> | null = null;

// ─── Notification ────────────────────────────────────────────────────

function showNotification(message: string, isError = false): void {
  let toast = document.getElementById('toast-notification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast-notification';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast show ${isError ? 'error' : 'success'}`;
  setTimeout(() => {
    if (toast) {
      toast.className = 'toast';
    }
  }, 4000);
}

// ─── Initial DOM ─────────────────────────────────────────────────────

function buildInitialDOM(): void {
  const root = document.getElementById('root');
  if (!root) {return;}

  const title = document.createElement('h1');
  title.textContent = 'Provider Configuration';

  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = 'Manage LLM providers and model selections';

  const sectionTitle = document.createElement('h2');
  sectionTitle.textContent = 'Providers';

  const providerList = document.createElement('div');
  providerList.id = 'provider-list';

  const buttonContainer = document.createElement('div');
  buttonContainer.style.margin = '12px 0';

  const addBtn = document.createElement('vscode-button') as HTMLElement;
  addBtn.id = 'add-provider-btn';
  addBtn.textContent = '+ Add Provider';
  addBtn.addEventListener('click', () => {
    editingProviderId = null;
    selectedEngineId = '';
    providerName = '';
    section1Open = true;
    section2Open = false;
    selectedModels.clear();
    leftSelected.clear();
    rightSelected.clear();
    discoveredModels = [];
    discoverError = null;
    isDiscovering = false;
    modelFilter = '';
    renderAccordion();
  });

  buttonContainer.appendChild(addBtn);

  const accordionContainer = document.createElement('div');
  accordionContainer.id = 'accordion-container';

  root.innerHTML = '';
  root.appendChild(title);
  root.appendChild(subtitle);
  root.appendChild(sectionTitle);
  root.appendChild(providerList);
  root.appendChild(buttonContainer);
  root.appendChild(accordionContainer);

  renderProviders();
  renderAccordion();
}

// ─── Render Providers ────────────────────────────────────────────────

function renderProviders(): void {
  const container = document.getElementById('provider-list');
  if (!container) {return;}

  container.innerHTML = '';

  if (providers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No providers configured yet';
    container.appendChild(empty);
    return;
  }

  providers.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'provider-card';

    const statusClass = p.healthy ? 'ready' : p.configured ? 'error' : 'unconfigured';

    const info = document.createElement('div');
    info.className = 'provider-info';

    const statusDot = document.createElement('span');
    statusDot.className = `provider-status ${statusClass}`;

    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = p.id;

    const engine = document.createElement('vscode-badge') as HTMLElement;
    engine.textContent = p.engine;

    const modelCount = document.createElement('span');
    modelCount.className = 'provider-model-count';
    modelCount.textContent = `${p.modelCount} ${p.modelCount === 1 ? 'model' : 'models'}`;

    info.appendChild(statusDot);
    info.appendChild(name);
    info.appendChild(engine);
    info.appendChild(modelCount);

    const actions = document.createElement('div');
    actions.className = 'provider-actions';

    const editBtn = document.createElement('vscode-button') as HTMLElement;
    editBtn.setAttribute('secondary', '');
    editBtn.className = 'card-action';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit provider';
    editBtn.addEventListener('click', () => startEdit(p));

    const deleteBtn = document.createElement('vscode-button') as HTMLElement;
    deleteBtn.setAttribute('secondary', '');
    deleteBtn.className = 'card-action';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Delete provider';
    deleteBtn.addEventListener('click', () => {
      vsCodeApi.postMessage({ type: 'removeProvider', providerId: p.id });
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(info);
    card.appendChild(actions);
    container.appendChild(card);
  });
}

// ─── Start Edit ──────────────────────────────────────────────────────

function startEdit(p: ProviderInfo): void {
  editingProviderId = p.id;
  selectedEngineId = p.engine;
  section1Open = true;
  section2Open = false;
  selectedModels.clear();
  leftSelected.clear();
  rightSelected.clear();
  discoveredModels = [];
  discoverError = null;
  isDiscovering = false;
  modelFilter = '';
  pendingEditModels = null;

  vsCodeApi.postMessage({ type: 'getConfig' });

  renderAccordion();

  setTimeout(() => {
    triggerModelDiscovery();
  }, 100);
}

// ─── Render Accordion ────────────────────────────────────────────────

function renderAccordion(): void {
  const container = document.getElementById('accordion-container');
  if (!container) {return;}

  container.innerHTML = '';

  if (editingProviderId === null && section1Open === false) {
    return;
  }

  const editing = providers.find((p) => p.id === editingProviderId);
  const selectedEngine = selectedEngineId || editing?.engine || '';
  const engineInfo = engines.find((e) => e.id === selectedEngine);
  const requiresKey = engineInfo?.requiresKey ?? false;

  const section1Complete = selectedEngine !== '';
  const section2Complete = selectedModels.size > 0;

  const wrapper = document.createElement('div');

  // ── Section 1: Provider Setup ──
  const section1 = document.createElement('div');
  section1.className = `accordion-section ${section1Open ? 'open' : ''}`;

  const header1 = document.createElement('div');
  header1.className = 'accordion-header';
  header1.addEventListener('click', () => {
    section1Open = !section1Open;
    renderAccordion();
  });

  const header1Left = document.createElement('div');
  header1Left.className = 'accordion-header-left';

  const chevron1 = document.createElement('span');
  chevron1.className = 'accordion-chevron';

  const title1 = document.createElement('span');
  title1.className = 'accordion-title';
  title1.textContent = '1. Provider Setup';

  header1Left.appendChild(chevron1);
  header1Left.appendChild(title1);

  const status1 = document.createElement('span');
  status1.className = `accordion-status ${section1Complete ? 'complete' : ''}`;
  if (section1Complete) {
    status1.textContent = 'Complete';
  }

  header1.appendChild(header1Left);
  header1.appendChild(status1);

  const body1 = document.createElement('div');
  body1.className = 'accordion-body';

  // Engine dropdown
  const engineGroup = document.createElement('vscode-form-group') as HTMLElement;
  engineGroup.setAttribute('variant', 'vertical');

  const engineLabel = document.createElement('vscode-label') as HTMLElement;
  engineLabel.setAttribute('for', 'engine-select');
  engineLabel.textContent = 'Engine';

  const engineSelect = document.createElement('vscode-single-select') as HTMLElement & { value: string };
  engineSelect.id = 'engine-select';

  const engineDefaultOption = document.createElement('vscode-option') as HTMLElement;
  engineDefaultOption.setAttribute('value', '');
  engineDefaultOption.textContent = 'Choose an engine...';
  engineSelect.appendChild(engineDefaultOption);

  [...engines].sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id)).forEach((e) => {
    const option = document.createElement('vscode-option') as HTMLElement;
    option.setAttribute('value', e.id);
    option.textContent = e.displayName || e.id;
    if (e.id === selectedEngine) {
      option.setAttribute('selected', '');
    }
    engineSelect.appendChild(option);
  });

  engineSelect.addEventListener('change', () => {
    selectedEngineId = engineSelect.value;
    discoveredModels = [];
    selectedModels.clear();
    leftSelected.clear();
    rightSelected.clear();
    discoverError = null;
    isDiscovering = false;
    renderAccordion();
    if (selectedEngineId) {
      triggerModelDiscovery();
    }
  });

  engineGroup.appendChild(engineLabel);
  engineGroup.appendChild(engineSelect);

  // Provider name
  const nameGroup = document.createElement('vscode-form-group') as HTMLElement;
  nameGroup.setAttribute('variant', 'vertical');

  const nameLabel = document.createElement('vscode-label') as HTMLElement;
  nameLabel.setAttribute('for', 'provider-name-input');
  nameLabel.textContent = 'Provider Name';

  const nameInput = document.createElement('vscode-textfield') as HTMLElement & { value: string };
  nameInput.id = 'provider-name-input';
  nameInput.setAttribute('value', editing ? editing.id : providerName);
  nameInput.setAttribute('placeholder', 'e.g. openai-prod');
  if (editing) {
    nameInput.setAttribute('readonly', '');
  }
  nameInput.addEventListener('input', () => {
    providerName = nameInput.value;
  });

  const nameHelper = document.createElement('vscode-form-helper') as HTMLElement;
  nameHelper.innerHTML = '<p>Letters, numbers, dots, underscores, and dashes only</p>';

  nameGroup.appendChild(nameLabel);
  nameGroup.appendChild(nameInput);
  nameGroup.appendChild(nameHelper);

  // Base URL
  const baseUrlGroup = document.createElement('vscode-form-group') as HTMLElement;
  baseUrlGroup.setAttribute('variant', 'vertical');
  baseUrlGroup.id = 'base-url-group';
  baseUrlGroup.style.display = engineInfo?.defaultBaseUrl ? 'block' : 'none';

  const baseUrlLabel = document.createElement('vscode-label') as HTMLElement;
  baseUrlLabel.setAttribute('for', 'base-url-input');
  baseUrlLabel.textContent = 'Base URL';

  const baseUrlInput = document.createElement('vscode-textfield') as HTMLElement & { value: string };
  baseUrlInput.id = 'base-url-input';
  baseUrlInput.setAttribute('value', editing?.baseUrl || engineInfo?.defaultBaseUrl || '');
  baseUrlInput.setAttribute('placeholder', engineInfo?.defaultBaseUrl || '');

  baseUrlGroup.appendChild(baseUrlLabel);
  baseUrlGroup.appendChild(baseUrlInput);

  // API key group
  const apiKeyGroupDiv = document.createElement('div');
  apiKeyGroupDiv.id = 'api-key-group';
  apiKeyGroupDiv.style.display = requiresKey ? 'block' : 'none';

  const toggleGroup = document.createElement('vscode-form-group') as HTMLElement;
  toggleGroup.setAttribute('variant', 'vertical');

  const toggleLabel = document.createElement('vscode-label') as HTMLElement;
  toggleLabel.textContent = 'API Key Storage';

  const radioGroup = document.createElement('vscode-radio-group') as HTMLElement & { value: string };

  const keychainRadio = document.createElement('vscode-radio') as HTMLElement;
  keychainRadio.setAttribute('label', 'Keychain');
  keychainRadio.setAttribute('value', 'keychain');
  if (apiKeyMethod === 'keychain') {keychainRadio.setAttribute('checked', '');}

  const envRadio = document.createElement('vscode-radio') as HTMLElement;
  envRadio.setAttribute('label', 'Environment Variable');
  envRadio.setAttribute('value', 'env');
  if (apiKeyMethod === 'env') {envRadio.setAttribute('checked', '');}

  radioGroup.appendChild(keychainRadio);
  radioGroup.appendChild(envRadio);

  radioGroup.addEventListener('change', () => {
    const checked = radioGroup.querySelector('vscode-radio[checked]') as HTMLElement | null;
    const val = checked?.getAttribute('value');
    if (val === 'keychain' || val === 'env') {
      apiKeyMethod = val;
      renderAccordion();
    }
  });

  toggleGroup.appendChild(toggleLabel);
  toggleGroup.appendChild(radioGroup);

  const keychainField = document.createElement('vscode-form-group') as HTMLElement;
  keychainField.setAttribute('variant', 'vertical');
  keychainField.id = 'keychain-field';
  keychainField.style.display = apiKeyMethod === 'keychain' ? 'block' : 'none';

  const apiKeyLabel = document.createElement('vscode-label') as HTMLElement;
  apiKeyLabel.setAttribute('for', 'api-key-input');
  apiKeyLabel.textContent = 'API Key';

  const apiKeyInput = document.createElement('vscode-textfield') as HTMLElement & { value: string };
  apiKeyInput.id = 'api-key-input';
  apiKeyInput.setAttribute('type', 'password');
  apiKeyInput.setAttribute('placeholder', 'Stored securely in system keychain');

  keychainField.appendChild(apiKeyLabel);
  keychainField.appendChild(apiKeyInput);

  const envField = document.createElement('vscode-form-group') as HTMLElement;
  envField.setAttribute('variant', 'vertical');
  envField.id = 'env-field';
  envField.style.display = apiKeyMethod === 'env' ? 'block' : 'none';

  const envVarLabel = document.createElement('vscode-label') as HTMLElement;
  envVarLabel.setAttribute('for', 'env-var-input');
  envVarLabel.textContent = 'Variable Name';

  const envVarInput = document.createElement('vscode-textfield') as HTMLElement & { value: string };
  envVarInput.id = 'env-var-input';
  envVarInput.setAttribute('value', engineInfo?.defaultEnvVar || '');
  envVarInput.setAttribute('placeholder', 'e.g. OPENAI_API_KEY');

  envField.appendChild(envVarLabel);
  envField.appendChild(envVarInput);

  apiKeyGroupDiv.appendChild(toggleGroup);
  apiKeyGroupDiv.appendChild(keychainField);
  apiKeyGroupDiv.appendChild(envField);

  body1.appendChild(engineGroup);
  body1.appendChild(nameGroup);
  body1.appendChild(baseUrlGroup);
  body1.appendChild(apiKeyGroupDiv);

  section1.appendChild(header1);
  section1.appendChild(body1);

  // ── Section 2: Select Models ──
  const section2 = document.createElement('div');
  section2.className = `accordion-section ${section2Open ? 'open' : ''}`;

  const header2 = document.createElement('div');
  header2.className = 'accordion-header';
  header2.addEventListener('click', () => {
    section2Open = !section2Open;
    if (section2Open && discoveredModels.length === 0 && !isDiscovering && selectedEngineId) {
      triggerModelDiscovery();
    }
    renderAccordion();
  });

  const header2Left = document.createElement('div');
  header2Left.className = 'accordion-header-left';

  const chevron2 = document.createElement('span');
  chevron2.className = 'accordion-chevron';

  const title2 = document.createElement('span');
  title2.className = 'accordion-title';
  title2.textContent = '2. Select Models';

  header2Left.appendChild(chevron2);
  header2Left.appendChild(title2);

  const status2 = document.createElement('span');
  status2.className = `accordion-status ${section2Complete ? 'complete' : ''}`;
  if (section2Complete) {
    status2.textContent = `${selectedModels.size} selected`;
  }

  header2.appendChild(header2Left);
  header2.appendChild(status2);

  const body2 = document.createElement('div');
  body2.className = 'accordion-body';

  const modelSectionContent = document.createElement('div');
  modelSectionContent.id = 'model-section-content';

  body2.appendChild(modelSectionContent);
  section2.appendChild(header2);
  section2.appendChild(body2);

  // Form actions
  const formActions = document.createElement('div');
  formActions.className = 'form-actions';

  const saveBtn = document.createElement('vscode-button') as HTMLElement;
  saveBtn.id = 'save-provider-btn';
  saveBtn.textContent = editing ? 'Update Provider' : 'Save Provider';
  saveBtn.addEventListener('click', handleSave);

  const cancelBtn = document.createElement('vscode-button') as HTMLElement;
  cancelBtn.id = 'cancel-btn';
  cancelBtn.setAttribute('secondary', '');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    editingProviderId = null;
    selectedEngineId = '';
    providerName = '';
    section1Open = false;
    section2Open = false;
    selectedModels.clear();
    leftSelected.clear();
    rightSelected.clear();
    discoveredModels = [];
    discoverError = null;
    isDiscovering = false;
    modelFilter = '';
    renderAccordion();
  });

  formActions.appendChild(saveBtn);
  formActions.appendChild(cancelBtn);

  wrapper.appendChild(section1);
  wrapper.appendChild(section2);
  wrapper.appendChild(formActions);

  container.appendChild(wrapper);

  renderModelSection();
}

// ─── Render Model Section ────────────────────────────────────────────

function renderModelSection(): void {
  const container = document.getElementById('model-section-content');
  if (!container) {return;}

  if (isDiscovering || discoverError || discoveredModels.length === 0) {
    container.innerHTML = '';

    if (isDiscovering) {
      const loading = document.createElement('div');
      loading.className = 'loading-state';

      const spinner = document.createElement('vscode-progress-ring') as HTMLElement;

      const loadingText = document.createElement('span');
      loadingText.textContent = 'Discovering models...';

      loading.appendChild(spinner);
      loading.appendChild(loadingText);
      container.appendChild(loading);
    } else if (discoverError) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'inline-error';

      const errorText = document.createElement('span');
      errorText.textContent = discoverError;

      const retryBtn = document.createElement('vscode-button') as HTMLElement;
      retryBtn.setAttribute('secondary', '');
      retryBtn.textContent = 'Retry';
      retryBtn.style.marginLeft = '8px';
      retryBtn.addEventListener('click', () => {
        discoverError = null;
        triggerModelDiscovery();
      });

      errorDiv.appendChild(errorText);
      errorDiv.appendChild(retryBtn);
      container.appendChild(errorDiv);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Select an engine and provider to discover models';
      container.appendChild(empty);
    }
    return;
  }

  const availableModels = discoveredModels.filter((m) => {
    if (modelFilter === '') {return true;}
    const display = (m.name || m.id).toLowerCase();
    return display.includes(modelFilter.toLowerCase());
  });

  const enabledEntries = Array.from(selectedModels.entries());

  if (!document.getElementById('model-search-input')) {
    const searchInput = document.createElement('vscode-textfield') as HTMLElement & { value: string };
    searchInput.id = 'model-search-input';
    searchInput.setAttribute('placeholder', 'Search models...');
    searchInput.setAttribute('value', modelFilter);
    searchInput.addEventListener('input', () => {
      modelFilter = searchInput.value;
      leftSelected.clear();
      renderModelSection();
    });
    container.appendChild(searchInput);
  }

  const oldDualList = container.querySelector('.dual-list');
  if (oldDualList) {
    oldDualList.remove();
  }

  const dualList = document.createElement('div');
  dualList.className = 'dual-list';

  // --- Left panel: Available ---
  const leftPanel = document.createElement('div');
  leftPanel.className = 'dual-list-panel';

  const leftHeader = document.createElement('div');
  leftHeader.className = 'dual-list-panel-header';
  leftHeader.textContent = `Available (${availableModels.length})`;

  const leftItems = document.createElement('div');
  leftItems.className = 'dual-list-items';

  availableModels.forEach((m) => {
    const item = document.createElement('div');
    item.className = `dual-list-item${leftSelected.has(m.id) ? ' selected' : ''}`;
    item.textContent = m.name || m.id;
    item.addEventListener('click', () => {
      if (leftSelected.has(m.id)) {
        leftSelected.delete(m.id);
      } else {
        leftSelected.add(m.id);
      }
      renderModelSection();
    });
    leftItems.appendChild(item);
  });

  leftPanel.appendChild(leftHeader);
  leftPanel.appendChild(leftItems);

  // --- Center: Action buttons ---
  const center = document.createElement('div');
  center.className = 'dual-list-center';

  const addBtn = document.createElement('vscode-button') as HTMLElement;
  addBtn.setAttribute('secondary', '');
  addBtn.textContent = 'Add →';
  if (leftSelected.size === 0) {addBtn.setAttribute('disabled', '');}
  addBtn.addEventListener('click', () => {
    for (const id of leftSelected) {
      let name = id;
      if (selectedModels.has(name)) {
        let i = 1;
        while (selectedModels.has(`${id}-${i}`)) {i++;}
        name = `${id}-${i}`;
      }
      selectedModels.set(name, id);
    }
    leftSelected.clear();
    renderModelSection();
    renderAccordion();
  });

  const removeBtn = document.createElement('vscode-button') as HTMLElement;
  removeBtn.setAttribute('secondary', '');
  removeBtn.textContent = '← Remove';
  if (rightSelected.size === 0) {removeBtn.setAttribute('disabled', '');}
  removeBtn.addEventListener('click', () => {
    for (const name of rightSelected) {
      selectedModels.delete(name);
    }
    rightSelected.clear();
    renderModelSection();
    renderAccordion();
  });

  center.appendChild(addBtn);
  center.appendChild(removeBtn);

  // --- Right panel: Enabled ---
  const rightPanel = document.createElement('div');
  rightPanel.className = 'dual-list-panel';

  const rightHeader = document.createElement('div');
  rightHeader.className = 'dual-list-panel-header';
  rightHeader.textContent = `Enabled (${enabledEntries.length})`;

  const rightItems = document.createElement('div');
  rightItems.className = 'dual-list-items';

  enabledEntries.forEach(([name]) => {
    const item = document.createElement('div');
    item.className = `dual-list-item${rightSelected.has(name) ? ' selected' : ''}`;
    item.textContent = name;
    item.addEventListener('click', () => {
      if (rightSelected.has(name)) {
        rightSelected.delete(name);
      } else {
        rightSelected.add(name);
      }
      renderModelSection();
    });
    rightItems.appendChild(item);
  });

  rightPanel.appendChild(rightHeader);
  rightPanel.appendChild(rightItems);

  dualList.appendChild(leftPanel);
  dualList.appendChild(center);
  dualList.appendChild(rightPanel);

  container.appendChild(dualList);
}

// ─── Apply Pending Models (edit flow) ────────────────────────────────

function applyPendingModels(): void {
  if (!pendingEditModels || discoveredModels.length === 0) {return;}

  for (const [name, cfg] of Object.entries(pendingEditModels)) {
    const modelId = cfg.model_id || name;
    selectedModels.set(name, modelId);
  }
  pendingEditModels = null;
  renderModelSection();
  renderAccordion();
}

// ─── Trigger Model Discovery ─────────────────────────────────────────

function triggerModelDiscovery(): void {
  const engineSelect = document.getElementById('engine-select') as HTMLElement & { value: string } | null;
  const providerNameInput = document.getElementById('provider-name-input') as HTMLElement & { value: string } | null;
  const apiKeyInput = document.getElementById('api-key-input') as HTMLElement & { value: string } | null;
  const baseUrlInput = document.getElementById('base-url-input') as HTMLElement & { value: string } | null;

  const engineId = engineSelect?.value || '';
  const providerId = providerNameInput?.value.trim() || editingProviderId || '';

  if (!engineId) {return;}

  isDiscovering = true;
  discoverError = null;
  renderModelSection();

  const msg: Record<string, unknown> = {
    type: 'discoverModels',
    engineId,
    providerId: providerId || undefined,
  };

  const apiKey = apiKeyInput?.value.trim();
  if (apiKey) {msg.apiKey = apiKey;}

  const baseUrl = baseUrlInput?.value.trim();
  if (baseUrl) {msg.baseUrl = baseUrl;}

  vsCodeApi.postMessage(msg);
}

// ─── Handle Save ─────────────────────────────────────────────────────

function handleSave(): void {
  const providerNameInput = document.getElementById('provider-name-input') as HTMLElement & { value: string } | null;
  const engineSelect = document.getElementById('engine-select') as HTMLElement & { value: string } | null;
  const baseUrlInput = document.getElementById('base-url-input') as HTMLElement & { value: string } | null;
  const apiKeyInput = document.getElementById('api-key-input') as HTMLElement & { value: string } | null;
  const envVarInput = document.getElementById('env-var-input') as HTMLElement & { value: string } | null;

  const providerId = providerNameInput?.value.trim() || '';
  const engine = engineSelect?.value || '';

  if (!providerId) {
    showNotification('Provider name is required', true);
    return;
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(providerId)) {
    showNotification('Provider name must contain only letters, numbers, dots, underscores, and dashes', true);
    return;
  }

  if (!engine) {
    showNotification('Engine is required', true);
    return;
  }

  const msg: Record<string, unknown> = {
    type: 'configureProvider',
    providerId,
    engine,
    models: Object.fromEntries(
      Array.from(selectedModels.entries()).map(([name, modelId]) => [name, { model_id: modelId }]),
    ),
  };

  const baseUrl = baseUrlInput?.value.trim();
  if (baseUrl) {
    msg.baseUrl = baseUrl;
  }

  const engineInfo = engines.find((e) => e.id === engine);
  if (engineInfo?.requiresKey) {
    if (apiKeyMethod === 'keychain') {
      const key = apiKeyInput?.value.trim() || '';
      if (!key && !editingProviderId) {
        showNotification('API key is required', true);
        return;
      }
      if (key) {
        msg.apiKey = key;
      }
    } else {
      const envVar = envVarInput?.value.trim() || '';
      if (!envVar) {
        showNotification('Variable name is required', true);
        return;
      }
      msg.envVarName = envVar;
    }
  }

  vsCodeApi.postMessage(msg);
}

// ─── Message Handler ─────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;

  switch (msg.type) {
    case 'providers':
      providers = msg.providers || [];
      renderProviders();
      break;

    case 'engines':
      engines = msg.engines || [];
      if (section1Open) {
        renderAccordion();
      }
      break;

    case 'config':
      if (editingProviderId && msg.config) {
        const cfgProviders = (msg.config as Record<string, unknown>).providers as Record<string, Record<string, unknown>> | undefined;
        const providerCfg = cfgProviders?.[editingProviderId];
        const models = providerCfg?.models as Record<string, { model_id?: string }> | undefined;
        if (models && Object.keys(models).length > 0) {
          pendingEditModels = models;
          applyPendingModels();
        }
      }
      break;

    case 'discoveredModels':
      isDiscovering = false;
      discoveredModels = msg.models || [];
      discoverError = null;
      applyPendingModels();
      renderModelSection();
      break;

    case 'configureResult':
      if (msg.success) {
        showNotification(`Provider ${msg.providerId} ${editingProviderId ? 'updated' : 'added'} successfully`);
        editingProviderId = null;
        selectedEngineId = '';
        providerName = '';
        section1Open = false;
        section2Open = false;
        selectedModels.clear();
        leftSelected.clear();
        rightSelected.clear();
        discoveredModels = [];
        discoverError = null;
        isDiscovering = false;
        modelFilter = '';
        renderAccordion();
      } else {
        showNotification(`Failed: ${msg.error}`, true);
      }
      break;

    case 'error':
      if (msg.context === 'discoverModels') {
        isDiscovering = false;
        discoverError = msg.message;
        renderModelSection();
      } else {
        showNotification(msg.message, true);
      }
      break;
  }
});

// ─── Init ────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    buildInitialDOM();
    vsCodeApi.postMessage({ type: 'ready' });
  });
} else {
  buildInitialDOM();
  vsCodeApi.postMessage({ type: 'ready' });
}
