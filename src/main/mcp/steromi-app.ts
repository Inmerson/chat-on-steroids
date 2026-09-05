import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SurfaceRegistrar } from './kernel.js';

export const STEROMI_APP_RESOURCE_URI = 'ui://steromi/control-panel.html';
export const STEROMI_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * These existing Steromi tools are intentionally callable from the embedded control panel.
 * The server still runs every ordinary live capability, read-only and ownership guard; the
 * App surface is another caller, never an authorization bypass.
 */
export const STEROMI_APP_CALLABLE_TOOLS = new Set([
  'steromi_dashboard',
  'observe',
  'exec_command',
  'write_stdin',
  'read',
  'session'
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Modern MCP Apps metadata plus the ChatGPT compatibility bit used by window.openai.callTool. */
export function steromiAppCallableMeta(meta?: Record<string, unknown>): Record<string, unknown> {
  const existing = meta ?? {};
  return {
    ...existing,
    ui: {
      ...record(existing['ui']),
      visibility: ['model', 'app']
    },
    'openai/widgetAccessible': true
  };
}

export const STEROMI_CONTROL_PANEL_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Steromi Control Panel</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--color-background-primary, #111827); color: var(--color-text-primary, #f3f4f6); }
    button, input, textarea { font: inherit; }
    .shell { min-height: 440px; border: 1px solid var(--color-border-light, #374151); border-radius: 16px; overflow: hidden; background: var(--color-background-secondary, #0f172a); }
    .topbar { display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--color-border-light, #374151); }
    .brand { font-weight:700; margin-right:auto; }
    .status { font-size:12px; opacity:.72; }
    .tabs { display:flex; gap:6px; padding:8px 10px; border-bottom:1px solid var(--color-border-light, #374151); overflow-x:auto; }
    .tab, .action { border:1px solid var(--color-border-light, #475569); background:transparent; color:inherit; border-radius:9px; padding:7px 10px; cursor:pointer; }
    .tab.active { background:var(--color-background-tertiary, #1f2937); }
    .panel { display:none; padding:14px; }
    .panel.active { display:block; }
    .row { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
    input, textarea { width:100%; border:1px solid var(--color-border-light, #475569); background:var(--color-background-primary, #111827); color:inherit; border-radius:9px; padding:9px 10px; }
    .row input { flex:1 1 240px; width:auto; }
    textarea { min-height:76px; resize:vertical; }
    pre { white-space:pre-wrap; word-break:break-word; max-height:300px; overflow:auto; border:1px solid var(--color-border-light, #374151); border-radius:10px; padding:10px; background:var(--color-background-primary, #111827); margin:8px 0 0; }
    img { width:100%; max-height:520px; object-fit:contain; border:1px solid var(--color-border-light, #374151); border-radius:10px; background:#000; }
    .hint { font-size:12px; opacity:.7; margin:8px 0 0; }
    .error { color:var(--color-text-danger, #f87171); }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">Steromi Control Panel</div>
      <div id="bridgeStatus" class="status">Connecting…</div>
      <button id="fullscreen" class="action" type="button">Fullscreen</button>
    </header>
    <nav class="tabs" aria-label="Control panel sections">
      <button class="tab active" data-tab="screen" type="button">Screen</button>
      <button class="tab" data-tab="terminal" type="button">Terminal</button>
      <button class="tab" data-tab="files" type="button">Files</button>
      <button class="tab" data-tab="sessions" type="button">Sessions</button>
    </nav>

    <section id="screen" class="panel active">
      <div class="row"><button id="refreshScreen" class="action" type="button">Refresh screen</button></div>
      <img id="screenImage" alt="Windows desktop capture" hidden />
      <pre id="screenText">Press “Refresh screen” to inspect the active Windows view.</pre>
    </section>

    <section id="terminal" class="panel">
      <div class="row"><input id="workdir" placeholder="Working directory, e.g. /project" /></div>
      <textarea id="command" placeholder="Command, e.g. npm test"></textarea>
      <div class="row">
        <button id="runCommand" class="action" type="button">Run</button>
        <button id="pollCommand" class="action" type="button" disabled>Poll session</button>
        <input id="stdin" placeholder="Optional stdin for running session" />
        <button id="sendStdin" class="action" type="button" disabled>Send</button>
      </div>
      <pre id="terminalOutput">No command run yet.</pre>
    </section>

    <section id="files" class="panel">
      <div class="row">
        <input id="filePath" placeholder="File or folder path, e.g. /project/src" />
        <button id="readFile" class="action" type="button">Read</button>
      </div>
      <pre id="fileOutput">Enter an approved path.</pre>
    </section>

    <section id="sessions" class="panel">
      <div class="row"><button id="refreshSession" class="action" type="button">Refresh session status</button></div>
      <pre id="sessionOutput">Press refresh to inspect the current recorded session.</pre>
    </section>
    <p class="hint" style="padding:0 14px 12px">Every action still passes through Steromi’s existing MCP permission, read-only, path and ownership guards.</p>
  </main>

  <script>
    (function () {
      var activeSession = null;
      var bridgeStatus = document.getElementById('bridgeStatus');

      function bridge() { return window.openai; }
      function setStatus(text, isError) {
        bridgeStatus.textContent = text;
        bridgeStatus.classList.toggle('error', Boolean(isError));
      }
      function contentText(result) {
        var items = result && Array.isArray(result.content) ? result.content : [];
        return items.filter(function (item) { return item && item.type === 'text'; })
          .map(function (item) { return item.text || ''; }).join('\n');
      }
      function imageItem(result) {
        var items = result && Array.isArray(result.content) ? result.content : [];
        return items.find(function (item) { return item && item.type === 'image' && item.data; });
      }
      async function callTool(name, args) {
        var api = bridge();
        if (!api || typeof api.callTool !== 'function') throw new Error('ChatGPT MCP App bridge is not available in this host.');
        setStatus('Running ' + name + '…', false);
        var result = await api.callTool(name, args || {});
        if (result && result.isError) throw new Error(contentText(result) || (name + ' failed'));
        setStatus('Connected', false);
        return result || {};
      }
      function showError(target, error) {
        target.textContent = error instanceof Error ? error.message : String(error);
        target.classList.add('error');
        setStatus('Action failed', true);
      }
      function showText(target, text) { target.classList.remove('error'); target.textContent = text || '(no output)'; }

      document.querySelectorAll('.tab').forEach(function (button) {
        button.addEventListener('click', function () {
          document.querySelectorAll('.tab').forEach(function (item) { item.classList.toggle('active', item === button); });
          document.querySelectorAll('.panel').forEach(function (panel) { panel.classList.toggle('active', panel.id === button.dataset.tab); });
        });
      });

      document.getElementById('fullscreen').addEventListener('click', async function () {
        try {
          var api = bridge();
          if (!api || typeof api.requestDisplayMode !== 'function') throw new Error('Fullscreen is not supported by this host.');
          await api.requestDisplayMode({ mode: 'fullscreen' });
        } catch (error) { setStatus(error instanceof Error ? error.message : String(error), true); }
      });

      document.getElementById('refreshScreen').addEventListener('click', async function () {
        var text = document.getElementById('screenText');
        var image = document.getElementById('screenImage');
        try {
          var result = await callTool('observe', { what: 'active', screenshot: true, max_width: 1200, max_elements: 40 });
          var picture = imageItem(result);
          if (picture) { image.src = 'data:' + (picture.mimeType || 'image/png') + ';base64,' + picture.data; image.hidden = false; }
          showText(text, contentText(result));
        } catch (error) { showError(text, error); }
      });

      async function renderTerminal(result) {
        var output = document.getElementById('terminalOutput');
        var structured = result && result.structuredContent ? result.structuredContent : {};
        activeSession = typeof structured.session_id === 'number' ? structured.session_id : null;
        document.getElementById('pollCommand').disabled = activeSession === null;
        document.getElementById('sendStdin').disabled = activeSession === null;
        showText(output, structured.output || contentText(result));
      }
      document.getElementById('runCommand').addEventListener('click', async function () {
        var output = document.getElementById('terminalOutput');
        try {
          var cmd = document.getElementById('command').value.trim();
          if (!cmd) throw new Error('Enter a command first.');
          var workdir = document.getElementById('workdir').value.trim();
          var args = { cmd: cmd, yield_time_ms: 1000 };
          if (workdir) args.workdir = workdir;
          await renderTerminal(await callTool('exec_command', args));
        } catch (error) { showError(output, error); }
      });
      document.getElementById('pollCommand').addEventListener('click', async function () {
        var output = document.getElementById('terminalOutput');
        try {
          if (activeSession === null) throw new Error('No running terminal session.');
          await renderTerminal(await callTool('write_stdin', { session_id: activeSession, chars: '', yield_time_ms: 1000 }));
        } catch (error) { showError(output, error); }
      });
      document.getElementById('sendStdin').addEventListener('click', async function () {
        var output = document.getElementById('terminalOutput');
        try {
          if (activeSession === null) throw new Error('No running terminal session.');
          var chars = document.getElementById('stdin').value;
          await renderTerminal(await callTool('write_stdin', { session_id: activeSession, chars: chars, yield_time_ms: 1000 }));
        } catch (error) { showError(output, error); }
      });

      document.getElementById('readFile').addEventListener('click', async function () {
        var output = document.getElementById('fileOutput');
        try {
          var path = document.getElementById('filePath').value.trim();
          if (!path) throw new Error('Enter a file or folder path first.');
          showText(output, contentText(await callTool('read', { paths: [path] })));
        } catch (error) { showError(output, error); }
      });

      document.getElementById('refreshSession').addEventListener('click', async function () {
        var output = document.getElementById('sessionOutput');
        try { showText(output, contentText(await callTool('session', { action: 'status' }))); }
        catch (error) { showError(output, error); }
      });

      setStatus(bridge() && typeof bridge().callTool === 'function' ? 'Connected' : 'Bridge unavailable', !(bridge() && typeof bridge().callTool === 'function'));
    })();
  </script>
</body>
</html>`;

export function registerSteromiApp(server: McpServer, reg: SurfaceRegistrar): void {
  server.registerResource(
    'Steromi Control Panel',
    STEROMI_APP_RESOURCE_URI,
    {
      title: 'Steromi Control Panel',
      description: 'Interactive Screen, Terminal, Files and Sessions control panel for Steromi.',
      mimeType: STEROMI_APP_MIME_TYPE
    },
    async () => ({
      contents: [
        {
          uri: STEROMI_APP_RESOURCE_URI,
          mimeType: STEROMI_APP_MIME_TYPE,
          text: STEROMI_CONTROL_PANEL_HTML
        }
      ]
    })
  );

  reg.register(
    'steromi_dashboard',
    {
      title: 'Open Steromi control panel',
      description:
        'Open the interactive Steromi control panel inside ChatGPT. It provides Screen, Terminal, Files and Sessions tabs and uses the same guarded Steromi tools as the model.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        ui: { resourceUri: STEROMI_APP_RESOURCE_URI, visibility: ['model', 'app'] },
        'openai/outputTemplate': STEROMI_APP_RESOURCE_URI,
        'openai/widgetAccessible': true
      }
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: 'Steromi control panel opened. The embedded panel exposes Screen, Terminal, Files and Sessions through the existing guarded Steromi tools.'
        }
      ],
      structuredContent: {
        surface: 'steromi',
        tabs: ['screen', 'terminal', 'files', 'sessions']
      }
    })
  );
}
