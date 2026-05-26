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

const selectedModels: Set<string> = new Set();
let editingProviderId: string | null = null;

let section1Open = true;
let section2Open = false;
let selectedEngineId = '';

let apiKeyMethod: 'keychain' | 'env' = 'keychain';
let isDiscovering = false;
let discoverError: string | null = null;
let modelFilter = '';

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

  const addBtn = document.createElement('button');
  addBtn.id = 'add-provider-btn';
  addBtn.className = 'primary';
  addBtn.textContent = '+ Add Provider';
  addBtn.addEventListener('click', () => {
    editingProviderId = null;
    selectedEngineId = '';
    section1Open = true;
    section2Open = false;
    selectedModels.clear();
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

    const engine = document.createElement('span');
    engine.className = 'provider-engine';
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

    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = 'Edit provider';
    editBtn.addEventListener('click', () => startEdit(p));

    const deleteBtn = document.createElement('button');
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
  discoveredModels = [];
  discoverError = null;
  isDiscovering = false;
  modelFilter = '';

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

  // Create wrapper
  const wrapper = document.createElement('div');

  // Section 1
  const section1 = document.createElement('div');
  section1.className = `accordion-section ${section1Open ? 'open' : ''}`;
  section1.id = 'accordion-section-1';

  const header1 = document.createElement('div');
  header1.className = 'accordion-header';
  header1.id = 'accordion-header-1';
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
  body1.id = 'accordion-body-1';

  // Engine dropdown
  const engineGroup = document.createElement('div');
  engineGroup.className = 'form-group';

  const engineLabel = document.createElement('label');
  engineLabel.htmlFor = 'engine-select';
  engineLabel.textContent = 'Engine';

  const engineSelect = document.createElement('select');
  engineSelect.id = 'engine-select';

  const engineDefaultOption = document.createElement('option');
  engineDefaultOption.value = '';
  engineDefaultOption.textContent = 'Choose an engine...';
  engineSelect.appendChild(engineDefaultOption);

  engines.forEach((e) => {
    const option = document.createElement('option');
    option.value = e.id;
    option.textContent = e.id;
    if (e.id === selectedEngine) {
      option.selected = true;
    }
    engineSelect.appendChild(option);
  });

  engineSelect.addEventListener('change', () => {
    selectedEngineId = engineSelect.value;
    discoveredModels = [];
    selectedModels.clear();
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
  const nameGroup = document.createElement('div');
  nameGroup.className = 'form-group';

  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'provider-name-input';
  nameLabel.textContent = 'Provider Name';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'provider-name-input';
  nameInput.value = editing ? editing.id : '';
  nameInput.placeholder = 'e.g. openai-prod';
  if (editing) {
    nameInput.readOnly = true;
  }

  const nameHint = document.createElement('div');
  nameHint.className = 'hint';
  nameHint.textContent = 'Letters, numbers, dots, underscores, and dashes only';

  nameGroup.appendChild(nameLabel);
  nameGroup.appendChild(nameInput);
  nameGroup.appendChild(nameHint);

  // Base URL
  const baseUrlGroup = document.createElement('div');
  baseUrlGroup.className = 'form-group';
  baseUrlGroup.id = 'base-url-group';
  baseUrlGroup.style.display = engineInfo?.defaultBaseUrl ? 'block' : 'none';

  const baseUrlLabel = document.createElement('label');
  baseUrlLabel.htmlFor = 'base-url-input';
  baseUrlLabel.textContent = 'Base URL';

  const baseUrlInput = document.createElement('input');
  baseUrlInput.type = 'text';
  baseUrlInput.id = 'base-url-input';
  baseUrlInput.value = editing?.baseUrl || engineInfo?.defaultBaseUrl || '';
  baseUrlInput.placeholder = engineInfo?.defaultBaseUrl || '';

  baseUrlGroup.appendChild(baseUrlLabel);
  baseUrlGroup.appendChild(baseUrlInput);

  // API key group
  const apiKeyGroupDiv = document.createElement('div');
  apiKeyGroupDiv.id = 'api-key-group';
  apiKeyGroupDiv.style.display = requiresKey ? 'block' : 'none';

  const toggleGroup = document.createElement('div');
  toggleGroup.className = 'form-group';

  const toggleLabel = document.createElement('label');
  toggleLabel.textContent = 'API Key Storage';

  const toggleButtons = document.createElement('div');
  toggleButtons.className = 'toggle-group';

  const toggleKeychain = document.createElement('button');
  toggleKeychain.id = 'toggle-keychain';
  toggleKeychain.textContent = 'Keychain';
  toggleKeychain.className = apiKeyMethod === 'keychain' ? 'active' : '';
  toggleKeychain.addEventListener('click', () => {
    apiKeyMethod = 'keychain';
    renderAccordion();
  });

  const toggleEnv = document.createElement('button');
  toggleEnv.id = 'toggle-env';
  toggleEnv.textContent = 'Environment Variable';
  toggleEnv.className = apiKeyMethod === 'env' ? 'active' : '';
  toggleEnv.addEventListener('click', () => {
    apiKeyMethod = 'env';
    renderAccordion();
  });

  toggleButtons.appendChild(toggleKeychain);
  toggleButtons.appendChild(toggleEnv);

  toggleGroup.appendChild(toggleLabel);
  toggleGroup.appendChild(toggleButtons);

  const keychainField = document.createElement('div');
  keychainField.className = 'form-group';
  keychainField.id = 'keychain-field';
  keychainField.style.display = apiKeyMethod === 'keychain' ? 'block' : 'none';

  const apiKeyLabel = document.createElement('label');
  apiKeyLabel.htmlFor = 'api-key-input';
  apiKeyLabel.textContent = 'API Key';

  const apiKeyInput = document.createElement('input');
  apiKeyInput.type = 'password';
  apiKeyInput.id = 'api-key-input';
  apiKeyInput.placeholder = 'Stored securely in system keychain';

  keychainField.appendChild(apiKeyLabel);
  keychainField.appendChild(apiKeyInput);

  const envField = document.createElement('div');
  envField.className = 'form-group';
  envField.id = 'env-field';
  envField.style.display = apiKeyMethod === 'env' ? 'block' : 'none';

  const envVarLabel = document.createElement('label');
  envVarLabel.htmlFor = 'env-var-input';
  envVarLabel.textContent = 'Variable Name';

  const envVarInput = document.createElement('input');
  envVarInput.type = 'text';
  envVarInput.id = 'env-var-input';
  envVarInput.value = engineInfo?.defaultEnvVar || '';
  envVarInput.placeholder = 'e.g. OPENAI_API_KEY';

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

  // Section 2
  const section2 = document.createElement('div');
  section2.className = `accordion-section ${section2Open ? 'open' : ''}`;
  section2.id = 'accordion-section-2';

  const header2 = document.createElement('div');
  header2.className = 'accordion-header';
  header2.id = 'accordion-header-2';
  header2.addEventListener('click', () => {
    section2Open = !section2Open;
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
  body2.id = 'accordion-body-2';

  const modelSectionContent = document.createElement('div');
  modelSectionContent.id = 'model-section-content';

  body2.appendChild(modelSectionContent);
  section2.appendChild(header2);
  section2.appendChild(body2);

  // Form actions
  const formActions = document.createElement('div');
  formActions.className = 'form-actions';

  const saveBtn = document.createElement('button');
  saveBtn.id = 'save-provider-btn';
  saveBtn.className = 'primary';
  saveBtn.textContent = editing ? 'Update Provider' : 'Save Provider';
  saveBtn.addEventListener('click', handleSave);

  const cancelBtn = document.createElement('button');
  cancelBtn.id = 'cancel-btn';
  cancelBtn.className = 'secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    editingProviderId = null;
    selectedEngineId = '';
    section1Open = false;
    section2Open = false;
    selectedModels.clear();
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

  container.innerHTML = '';

  if (isDiscovering) {
    const loading = document.createElement('div');
    loading.className = 'loading-state';

    const spinner = document.createElement('span');
    spinner.className = 'spinner';

    const loadingText = document.createElement('span');
    loadingText.textContent = 'Discovering models...';

    loading.appendChild(spinner);
    loading.appendChild(loadingText);
    container.appendChild(loading);
    return;
  }

  if (discoverError) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'inline-error';

    const errorText = document.createElement('span');
    errorText.textContent = discoverError;

    const retryLink = document.createElement('button');
    retryLink.className = 'link';
    retryLink.textContent = 'Retry';
    retryLink.style.marginLeft = '8px';
    retryLink.addEventListener('click', () => {
      discoverError = null;
      triggerModelDiscovery();
    });

    errorDiv.appendChild(errorText);
    errorDiv.appendChild(retryLink);
    container.appendChild(errorDiv);
    return;
  }

  if (discoveredModels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select an engine and provider to discover models';
    container.appendChild(empty);
    return;
  }

  // Filter models
  const filteredModels = discoveredModels.filter((m) => {
    if (modelFilter === '') {return true;}
    const display = (m.name || m.id).toLowerCase();
    return display.includes(modelFilter.toLowerCase());
  });

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'model-search';
  searchInput.id = 'model-search-input';
  searchInput.placeholder = 'Search models...';
  searchInput.value = modelFilter;
  searchInput.addEventListener('input', (e) => {
    modelFilter = (e.target as HTMLInputElement).value;
    renderModelSection();
  });

  const modelActions = document.createElement('div');
  modelActions.className = 'model-actions';

  const selectAllLink = document.createElement('button');
  selectAllLink.className = 'link';
  selectAllLink.id = 'select-all-link';
  selectAllLink.textContent = 'Select all';
  selectAllLink.addEventListener('click', () => {
    filteredModels.forEach((m) => selectedModels.add(m.id));
    renderModelSection();
    renderAccordion();
  });

  const deselectAllLink = document.createElement('button');
  deselectAllLink.className = 'link';
  deselectAllLink.id = 'deselect-all-link';
  deselectAllLink.textContent = 'Deselect all';
  deselectAllLink.addEventListener('click', () => {
    selectedModels.clear();
    renderModelSection();
    renderAccordion();
  });

  modelActions.appendChild(selectAllLink);
  modelActions.appendChild(deselectAllLink);

  const modelCounter = document.createElement('div');
  modelCounter.className = 'model-counter';
  modelCounter.textContent = `${selectedModels.size} of ${filteredModels.length} selected`;

  const modelList = document.createElement('div');
  modelList.className = 'model-list';
  modelList.id = 'model-list';

  filteredModels.forEach((m) => {
    const item = document.createElement('div');
    item.className = 'model-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `model-${m.id}`;
    checkbox.checked = selectedModels.has(m.id);
    checkbox.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).checked) {
        selectedModels.add(m.id);
      } else {
        selectedModels.delete(m.id);
      }
      renderModelSection();
      renderAccordion();
    });

    const label = document.createElement('label');
    label.htmlFor = `model-${m.id}`;
    label.textContent = m.name || m.id;

    item.appendChild(checkbox);
    item.appendChild(label);
    modelList.appendChild(item);
  });

  container.appendChild(searchInput);
  container.appendChild(modelActions);
  container.appendChild(modelCounter);
  container.appendChild(modelList);
}

// ─── Trigger Model Discovery ─────────────────────────────────────────

function triggerModelDiscovery(): void {
  const engineSelect = document.getElementById('engine-select') as HTMLSelectElement;
  const providerNameInput = document.getElementById('provider-name-input') as HTMLInputElement;

  const engineId = engineSelect?.value || '';
  const providerId = providerNameInput?.value.trim() || editingProviderId || '';

  if (!engineId) {return;}

  isDiscovering = true;
  discoverError = null;
  renderModelSection();

  vsCodeApi.postMessage({
    type: 'discoverModels',
    engineId,
    providerId: providerId || undefined,
  });
}

// ─── Handle Save ─────────────────────────────────────────────────────

function handleSave(): void {
  const providerNameInput = document.getElementById('provider-name-input') as HTMLInputElement;
  const engineSelect = document.getElementById('engine-select') as HTMLSelectElement;
  const baseUrlInput = document.getElementById('base-url-input') as HTMLInputElement;
  const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
  const envVarInput = document.getElementById('env-var-input') as HTMLInputElement;

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
    models: Array.from(selectedModels),
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

    case 'discoveredModels':
      isDiscovering = false;
      discoveredModels = msg.models || [];
      discoverError = null;
      renderModelSection();
      break;

    case 'configureResult':
      if (msg.success) {
        showNotification(`Provider ${msg.providerId} ${editingProviderId ? 'updated' : 'added'} successfully`);
        editingProviderId = null;
        selectedEngineId = '';
        section1Open = false;
        section2Open = false;
        selectedModels.clear();
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
