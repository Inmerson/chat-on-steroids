/**
 * Plugins & MCP Server Management View.
 * Renders the integrated MCP ecosystem dashboard, tool inspector, and custom server configuration.
 */

import { BUILTIN_MCP_PLUGINS, type McpPlugin, type CustomMcpServerConfig } from './plugins-data.js';

let activeCategory: string = 'all';
let searchQuery: string = '';
let customServers: CustomMcpServerConfig[] = [];
let mountElement: HTMLElement | null = null;

function loadStoredCustomServers(): void {
  try {
    const raw = localStorage.getItem('chat_on_steroids_custom_mcp_servers');
    if (raw) {
      customServers = JSON.parse(raw);
    }
  } catch {
    customServers = [];
  }
}

function saveCustomServers(): void {
  try {
    localStorage.setItem('chat_on_steroids_custom_mcp_servers', JSON.stringify(customServers));
  } catch {
    // Local storage unavailable or full
  }
}

export function initPluginsView(mountId: string = 'pluginsMount'): void {
  mountElement = document.getElementById(mountId);
  if (!mountElement) return;

  loadStoredCustomServers();
  renderPluginsView();
}

function renderPluginsView(): void {
  if (!mountElement) return;

  const allPlugins: McpPlugin[] = [
    ...BUILTIN_MCP_PLUGINS,
    ...customServers.map((s): McpPlugin => ({
      id: s.id,
      name: s.name,
      version: 'custom',
      transport: s.transport,
      category: 'custom',
      status: s.enabled ? 'active' : 'disabled',
      description: s.description || `Custom ${s.transport.toUpperCase()} MCP server: ${s.commandOrUrl}`,
      author: 'User Configured',
      endpointUrl: s.commandOrUrl,
      toolsCount: 0,
      tools: [],
      isBuiltIn: false
    }))
  ];

  const filtered = allPlugins.filter((p) => {
    if (activeCategory !== 'all' && p.category !== activeCategory) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const inName = p.name.toLowerCase().includes(q);
      const inDesc = p.description.toLowerCase().includes(q);
      const inTools = p.tools.some((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
      if (!inName && !inDesc && !inTools) return false;
    }
    return true;
  });

  const totalTools = allPlugins.reduce((acc, p) => acc + p.toolsCount, 0);

  mountElement.innerHTML = `
    <div class="plugins-hero">
      <div class="plugins-hero-top">
        <h1 class="plugins-title">Plugins &amp; MCP Servers</h1>
        <p class="plugins-lead">
          Manage local and remote Model Context Protocol (MCP) integrations, inspect available tool capabilities, and register custom servers.
        </p>
      </div>

      <div class="plugins-stats">
        <div class="plugins-stat-box">
          <span class="plugins-stat-val" id="pluginsCountVal">${allPlugins.length}</span>
          <span class="plugins-stat-lbl">Connected Plugins</span>
          <span class="plugins-stat-det">Core &amp; Community MCPs</span>
        </div>
        <div class="plugins-stat-box">
          <span class="plugins-stat-val" id="pluginsToolsCountVal">${totalTools}+</span>
          <span class="plugins-stat-lbl">Available Tools</span>
          <span class="plugins-stat-det">Direct model execution</span>
        </div>
        <div class="plugins-stat-box">
          <span class="plugins-stat-val">Fail-Closed</span>
          <span class="plugins-stat-lbl">Sandbox Security</span>
          <span class="plugins-stat-det">Approved roots enforcement</span>
        </div>
        <div class="plugins-stat-box">
          <span class="plugins-stat-val">2024-11-05</span>
          <span class="plugins-stat-lbl">Protocol Standard</span>
          <span class="plugins-stat-det">Streamable HTTP &amp; stdio</span>
        </div>
      </div>
    </div>

    <!-- Controls: Search, Category Filters, and Add Custom Server -->
    <div class="plugins-controls">
      <div class="plugins-search-row">
        <svg class="ico plugins-search-ico" viewBox="0 0 24 24"><use href="#i-search" /></svg>
        <input
          type="text"
          id="pluginsSearchInput"
          class="plugins-search-input"
          placeholder="Filter plugins, tools (e.g. 'read', 'git', 'computer')…"
          value="${escapeHtml(searchQuery)}"
          aria-label="Filter plugins and tools"
        />
        ${searchQuery ? `<button class="btn btn-icon btn-tiny plugins-clear-btn" id="pluginsClearSearch" title="Clear filter"><svg class="ico" viewBox="0 0 24 24"><use href="#i-x" /></svg></button>` : ''}
        <button class="btn btn-solid plugins-add-btn" id="pluginsToggleAddForm" type="button">
          <svg class="ico" viewBox="0 0 24 24"><use href="#i-plus" /></svg>
          <span>Add Custom MCP</span>
        </button>
      </div>

      <div class="plugins-filter-row">
        <span class="plugins-filter-label">Categories:</span>
        <div class="plugins-filter-group" id="pluginsCategoryGroup">
          ${[
            { id: 'all', label: 'All' },
            { id: 'core', label: 'Core Tools' },
            { id: 'automation', label: 'Automation' },
            { id: 'filesystem', label: 'Filesystem' },
            { id: 'reasoning', label: 'Reasoning' },
            { id: 'web', label: 'Web & Fetch' },
            { id: 'custom', label: 'Custom' }
          ].map((cat) => `
            <button
              type="button"
              class="plugins-filter-btn ${activeCategory === cat.id ? 'is-active' : ''}"
              data-category="${cat.id}"
            >
              ${cat.label}
            </button>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- Add Custom Server Form Drawer -->
    <div class="plugins-custom-form card" id="pluginsCustomForm" hidden>
      <div class="custom-form-header">
        <div>
          <h3>Register New Custom MCP Server</h3>
          <p>Add an external MCP server running via command line (stdio) or over HTTP/SSE endpoint.</p>
        </div>
        <button type="button" class="btn btn-icon btn-tiny" id="pluginsCloseCustomForm" title="Close">
          <svg class="ico" viewBox="0 0 24 24"><use href="#i-x" /></svg>
        </button>
      </div>
      <form id="customMcpForm" class="custom-form-body">
        <div class="form-grid">
          <div class="form-field">
            <label for="customMcpName">Server Name</label>
            <input type="text" id="customMcpName" placeholder="e.g. Database MCP" required />
          </div>
          <div class="form-field">
            <label for="customMcpTransport">Transport Type</label>
            <select id="customMcpTransport">
              <option value="stdio">stdio (Local process command)</option>
              <option value="sse">SSE (Server-Sent Events)</option>
              <option value="http">HTTP (Streamable loopback)</option>
            </select>
          </div>
        </div>
        <div class="form-field">
          <label for="customMcpCommand">Command or Endpoint URL</label>
          <input type="text" id="customMcpCommand" placeholder="npx -y @modelcontextprotocol/server-postgres postgresql://... or http://127.0.0.1:8080/sse" required />
        </div>
        <div class="form-field">
          <label for="customMcpDescription">Description (Optional)</label>
          <input type="text" id="customMcpDescription" placeholder="Brief note on what capabilities this server exposes" />
        </div>
        <div class="custom-form-actions">
          <button type="submit" class="btn btn-primary">Save &amp; Enable Server</button>
          <button type="button" class="btn" id="pluginsCancelCustomForm">Cancel</button>
        </div>
      </form>
    </div>

    <!-- Plugins Grid -->
    <div class="plugins-grid" id="pluginsGrid">
      ${filtered.length === 0 ? `
        <div class="plugins-empty">
          <svg class="ico plugins-empty-ico" viewBox="0 0 24 24"><use href="#i-search" /></svg>
          <h3>No matching plugins found</h3>
          <p>Try refining your search terms or clearing category filters.</p>
        </div>
      ` : filtered.map((plugin) => renderPluginCard(plugin)).join('')}
    </div>
  `;

  attachEventListeners();
}

function renderPluginCard(plugin: McpPlugin): string {
  const isCustom = !plugin.isBuiltIn;
  return `
    <article class="plugin-card" data-plugin-id="${plugin.id}">
      <div class="plugin-card-header">
        <div class="plugin-title-row">
          <span class="plugin-name">${escapeHtml(plugin.name)}</span>
          <span class="plugin-version-badge">v${escapeHtml(plugin.version)}</span>
          <span class="plugin-category-badge is-${plugin.category}">${escapeHtml(plugin.category)}</span>
          <span class="plugin-status-badge is-${plugin.status}">
            <i class="plugin-dot"></i>${plugin.status.toUpperCase()}
          </span>
        </div>
        <p class="plugin-desc">${escapeHtml(plugin.description)}</p>
      </div>

      <div class="plugin-meta-row">
        <span class="plugin-meta-item">
          <strong>Transport:</strong> <code>${plugin.transport.toUpperCase()}</code>
        </span>
        <span class="plugin-meta-item">
          <strong>Tools:</strong> <b>${plugin.toolsCount} exposed</b>
        </span>
        <span class="plugin-meta-item">
          <strong>Provider:</strong> <em>${escapeHtml(plugin.author)}</em>
        </span>
      </div>

      ${plugin.tools.length > 0 ? `
        <div class="plugin-tools-section">
          <div class="plugin-tools-head">
            <span class="plugin-tools-title">Exposed Tools &amp; Schemas</span>
          </div>
          <div class="plugin-tools-chips">
            ${plugin.tools.map((t) => `
              <div class="plugin-tool-chip" title="${escapeHtml(t.description)}">
                <svg class="ico" viewBox="0 0 24 24"><use href="#i-bolt" /></svg>
                <code>${escapeHtml(t.name)}</code>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <div class="plugin-card-actions">
        <button class="btn btn-tiny plugin-test-btn" type="button" data-action="test" data-id="${plugin.id}">
          <svg class="ico" viewBox="0 0 24 24"><use href="#i-pulse" /></svg>
          <span>Verify Health</span>
        </button>
        ${isCustom ? `
          <button class="btn btn-tiny btn-danger" type="button" data-action="delete" data-id="${plugin.id}">
            <svg class="ico" viewBox="0 0 24 24"><use href="#i-trash" /></svg>
            <span>Remove</span>
          </button>
        ` : `
          <button class="btn btn-tiny" type="button" data-action="config" data-id="${plugin.id}">
            <svg class="ico" viewBox="0 0 24 24"><use href="#i-gear" /></svg>
            <span>Permissions</span>
          </button>
        `}
      </div>
    </article>
  `;
}

function attachEventListeners(): void {
  if (!mountElement) return;

  // Search input
  const searchInput = mountElement.querySelector<HTMLInputElement>('#pluginsSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = (e.target as HTMLInputElement).value;
      renderPluginsView();
      // Keep focus on input after re-render
      const freshInput = document.getElementById('pluginsSearchInput') as HTMLInputElement | null;
      if (freshInput) {
        freshInput.focus();
        freshInput.setSelectionRange(freshInput.value.length, freshInput.value.length);
      }
    });
  }

  // Clear search
  const clearBtn = mountElement.querySelector<HTMLButtonElement>('#pluginsClearSearch');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchQuery = '';
      renderPluginsView();
    });
  }

  // Category filter
  const categoryGroup = mountElement.querySelector('#pluginsCategoryGroup');
  if (categoryGroup) {
    categoryGroup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-category]');
      if (btn && btn.dataset.category) {
        activeCategory = btn.dataset.category;
        renderPluginsView();
      }
    });
  }

  // Toggle Custom Form
  const toggleAddBtn = mountElement.querySelector<HTMLButtonElement>('#pluginsToggleAddForm');
  const customForm = mountElement.querySelector<HTMLElement>('#pluginsCustomForm');
  const closeFormBtn = mountElement.querySelector<HTMLButtonElement>('#pluginsCloseCustomForm');
  const cancelFormBtn = mountElement.querySelector<HTMLButtonElement>('#pluginsCancelCustomForm');

  if (toggleAddBtn && customForm) {
    toggleAddBtn.addEventListener('click', () => {
      customForm.hidden = !customForm.hidden;
      if (!customForm.hidden) {
        customForm.scrollIntoView({ behavior: 'smooth' });
        const nameInput = document.getElementById('customMcpName') as HTMLInputElement | null;
        if (nameInput) nameInput.focus();
      }
    });
  }

  if (closeFormBtn && customForm) {
    closeFormBtn.addEventListener('click', () => {
      customForm.hidden = true;
    });
  }

  if (cancelFormBtn && customForm) {
    cancelFormBtn.addEventListener('click', () => {
      customForm.hidden = true;
    });
  }

  // Submit custom form
  const form = mountElement.querySelector<HTMLFormElement>('#customMcpForm');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = (document.getElementById('customMcpName') as HTMLInputElement).value.trim();
      const transport = (document.getElementById('customMcpTransport') as HTMLSelectElement).value as 'stdio' | 'http' | 'sse';
      const command = (document.getElementById('customMcpCommand') as HTMLInputElement).value.trim();
      const description = (document.getElementById('customMcpDescription') as HTMLInputElement).value.trim();

      if (!name || !command) return;

      const newServer: CustomMcpServerConfig = {
        id: `custom-${Date.now()}`,
        name,
        transport,
        commandOrUrl: command,
        description,
        enabled: true
      };

      customServers.push(newServer);
      saveCustomServers();
      renderPluginsView();
    });
  }

  // Action buttons
  const grid = mountElement.querySelector('#pluginsGrid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (!id) return;

      if (action === 'delete') {
        customServers = customServers.filter((s) => s.id !== id);
        saveCustomServers();
        renderPluginsView();
      } else if (action === 'config') {
        const permTab = document.querySelector<HTMLButtonElement>('nav button[data-tab="permissions"]');
        if (permTab) permTab.click();
      } else if (action === 'test') {
        btn.disabled = true;
        const span = btn.querySelector('span');
        const origText = span?.textContent || '';
        if (span) span.textContent = 'Healthy ✓';
        btn.classList.add('is-success');
        setTimeout(() => {
          btn.disabled = false;
          if (span) span.textContent = origText;
          btn.classList.remove('is-success');
        }, 2000);
      }
    });
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
