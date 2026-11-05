import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'pi-resource-center-mcp-'));
const cwd = join(home, 'project');
const agentDir = join(home, 'agent');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { discoverMcpServers, openNativeMcpManager, updateMcpToolInventory } = await import('../src/resource/mcp.ts');
const { setMcpServerEnabled } = await import('../src/resource/mcp-mutations.ts');
const { discoverResources } = await import('../src/resource/discovery.ts');
const { ResourceBrowser } = await import('../src/browser/browser.ts');
const { getDetailActions } = await import('../src/browser/actions.ts');
const { canRemoveResourceIndividually } = await import('../src/resource/capabilities.ts');
const { DEFAULT_RESOURCE_CENTER_SETTINGS } = await import('../src/settings/shared.ts');
const { buildToolResourceItems } = await import('../src/resource/tool-runtime.ts');
const { ResourceCompletionProvider } = await import('../src/resource/completions.ts');
const { handleMutateCommand, handleAddCommand } = await import('../src/resource/commands.ts');
const { getKeybindings, visibleWidth } = await import('@earendil-works/pi-tui');
const theme = new Proxy({ name: 'system', fg: (_color, text) => text, bg: (_color, text) => text }, {
  get: (target, key) => key in target ? target[key] : (text) => text,
});
const userConfig = join(agentDir, 'mcp.json');
const projectConfig = join(cwd, '.pi', 'mcp.json');
const save = (path, value) => writeFile(path, JSON.stringify(value), 'utf8');
const tool = (server, name = 'search', exposure = 'codemode') => ({
  name: `mcp__${server}__${name}`, description: `${server} ${name}`, exposure, namespace: { name: `mcp__${server}` },
  sourceInfo: { source: 'builtin', path: 'builtin:mcp', scope: 'user', origin: 'top-level' },
});
const runtime = (tools = [], registrations = []) => ({ getAllTools: () => tools, getActiveTools: () => [], setActiveTools() {},
  getMcpServers: () => registrations });
const discover = (trusted = false, host = runtime()) => discoverMcpServers(cwd, trusted, host, host.getAllTools(), host.getActiveTools());

beforeEach(async () => {
  await Promise.all([rm(cwd, { recursive: true, force: true }), rm(agentDir, { recursive: true, force: true })]);
  await Promise.all([mkdir(join(cwd, '.pi'), { recursive: true }), mkdir(agentDir)]);
});
after(() => rm(home, { recursive: true, force: true }));

test('MCP discovery includes disabled servers without connecting or exposing config secrets', async () => {
  await save(userConfig, { mcpServers: {
    docs: { url: 'https://user:secret@example.test/mcp?token=private', headers: { Authorization: 'secret-header' } },
    local: { command: 'node', args: ['--token', 'secret-argument'], env: { KEY: 'secret-env' }, enabled: false },
  } });
  const original = await readFile(userConfig, 'utf8');
  const items = await discover();
  assert.equal(items.length, 2);
  assert.equal(items.find((item) => item.name === 'local').configState, 'disabled');
  assert.equal(items.find((item) => item.name === 'docs').transport, 'http');
  assert.equal(items.find((item) => item.name === 'local').transport, 'stdio');
  assert.equal(JSON.stringify(items).includes('secret'), false);
  assert.equal(JSON.stringify(items).includes('private'), false);
  assert.equal(await readFile(userConfig, 'utf8'), original);
});

test('MCP project config and overrides are ignored until trust is granted', async () => {
  await save(userConfig, { mcpServers: { docs: { url: 'https://example.test', exposure: 'deferred' } } });
  await save(projectConfig, { mcpServers: { docs: { enabled: false }, projectOnly: { command: 'node' } } });
  const untrusted = await discover();
  assert.deepEqual(untrusted.map((item) => item.name), ['docs']);
  assert.equal(untrusted[0].configState, 'enabled');
  assert.equal(untrusted[0].scope, 'user');
  const trusted = await discover(true);
  const docs = trusted.find((item) => item.name === 'docs');
  assert.equal(docs.configState, 'disabled');
  assert.equal(docs.scope, 'project');
  assert.equal(docs.exposure, 'deferred');
  assert.equal(docs.transport, 'http');
  assert.equal(docs.sourceLabel, 'user + project override');
  assert(trusted.some((item) => item.name === 'projectOnly'));
});

test('file definitions override extension registrations, but runtime-only namespaces remain visible', async () => {
  await save(userConfig, { mcpServers: { 'docs-server': { url: 'https://example.test', enabled: false } } });
  const host = runtime([tool('docs_server'), tool('extra'), tool('extra', 'withdrawn', 'hidden')], [
    { name: 'docs-server', config: { command: 'node' }, extensionPath: '/extension.ts' },
    { name: 'registered', config: { command: 'node' }, extensionPath: '/extension.ts' },
  ]);
  const items = await discover(false, host);
  assert.equal(items.length, 3);
  assert.equal(items.find((item) => item.name === 'docs-server').configState, 'disabled');
  assert.equal(items.find((item) => item.name === 'registered').scope, 'session');
  const extra = items.find((item) => item.name === 'extra');
  assert.equal(extra.configState, 'unknown');
  assert.deepEqual(extra.toolNames, ['mcp__extra__search']);
});

test('MCP resource access is explicitly shared and unqueried, not a fabricated server inventory', async () => {
  await save(userConfig, { mcpServers: { docs: { command: 'node' } } });
  const tools = [tool('docs'), { ...tool('ignored'), name: 'list_mcp_resources', namespace: undefined }];
  const items = await discoverMcpServers(cwd, false, runtime(tools), tools, [tools[0].name]);
  assert.deepEqual(items[0].resourceTools, ['list_mcp_resources']);
  assert.equal(items[0].activeToolCount, 1);
  assert.equal('resources' in items[0], false);
  const full = await discoverResources(cwd, 'system', { projectTrusted: false, syncExternalSkills: false, toolRuntime: runtime(tools) });
  assert.equal(full.categories.mcp.length, 1);
  assert(full.categories.tools.some((item) => item.name === 'mcp__docs__search'));
});

test('runtime-only inventory merge updates late tools and keeps configured servers when tools disappear', async () => {
  await save(userConfig, { mcpServers: { docs: { command: 'node' }, disabled: { command: 'node', enabled: false } } });
  const original = await discover();
  assert.equal(original.find((item) => item.name === 'docs').toolsLoading, true);
  assert.equal(original.find((item) => item.name === 'disabled').toolsLoading, false);
  const tools = [tool('docs'), tool('extra'), tool('docs', 'secret', 'hidden'),
    { ...tool('ignored'), name: 'list_mcp_resources', namespace: undefined }];
  const updated = updateMcpToolInventory(original, tools, ['mcp__docs__search']);
  assert.deepEqual(updated.find((item) => item.name === 'docs').toolNames, ['mcp__docs__search']);
  assert.equal(updated.find((item) => item.name === 'docs').activeToolCount, 1);
  assert.deepEqual(updated.find((item) => item.name === 'docs').resourceTools, ['list_mcp_resources']);
  assert.equal(updated.find((item) => item.name === 'disabled').configState, 'disabled');
  assert.equal(updated.find((item) => item.name === 'extra').toggleMode, 'none');
  assert.deepEqual(original.find((item) => item.name === 'docs').toolNames, [], 'do not mutate previous snapshots');
  const withdrawn = updateMcpToolInventory(updated, tools.map((item) => ({ ...item, exposure: 'hidden' })), []);
  assert.deepEqual(withdrawn.map((item) => item.name).sort(), ['disabled', 'docs']);
  assert.deepEqual(withdrawn.find((item) => item.name === 'docs').toolNames, []);
  assert.equal(withdrawn.find((item) => item.name === 'docs').toolsLoading, false, 'withdrawn tools become zero, not fetching again');
  assert.deepEqual(withdrawn.find((item) => item.name === 'docs').resourceTools, []);
});

test('BOM and malformed MCP config are handled without breaking resource discovery', async () => {
  await writeFile(userConfig, '\uFEFF' + JSON.stringify({ mcpServers: { docs: { command: 'node' } } }), 'utf8');
  assert.equal((await discover())[0].name, 'docs');
  await writeFile(userConfig, '{ "mcpServers": [', 'utf8');
  const items = await discover();
  assert.equal(items[0].configState, 'error');
  assert.match(items[0].description, /native \/mcp/);
  await save(projectConfig, { mcpServers: { orphan: { enabled: false } } });
  assert.equal((await discover(true)).filter((item) => item.configState === 'error').length, 2);
});

async function browserFixture(callbacks = {}) {
  await save(userConfig, { mcpServers: { docs: { command: 'node' } } });
  const rawTools = [tool('docs'), tool('docs', 'read'), tool('docs_extra')];
  const items = await discover(false, runtime(rawTools));
  const categories = { packages: [], skills: [], extensions: [], prompts: [], themes: [],
    tools: buildToolResourceItems(rawTools, [], 'user'), mcp: items };
  return { item: items.find((item) => item.name === 'docs'), browser: new ResourceBrowser(theme, { categories }, 'mcp',
    structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS), { onClose() {}, ...callbacks }, cwd, getKeybindings()) };
}

test('MCP browser toggles configuration with Space and keeps native management on M', async () => {
  let managed = 0;
  let toggled;
  const { browser, item } = await browserFixture({ onManageMcp: () => managed++, onToggle: (item) => { toggled = item; } });
  assert.deepEqual(getDetailActions(item), ['toggle', 'mcp-manager', 'mcp-tools', 'pin', 'back']);
  assert.equal(canRemoveResourceIndividually(item), false);
  assert.match(browser.render(120).join('\n'), /\[x\] docs \[2 tools\]/);
  browser.handleInput(' ');
  assert.equal(managed, 0);
  assert.equal(toggled, item);
  assert.equal(item.enabled, false);
  browser.handleInput('M');
  assert.equal(managed, 1);
  browser.handleInput('\r');
  const details = browser.render(160).join('\n');
  assert.match(details, /not connection status/);
  assert.match(details, /Resources: Not queried/);
  assert.match(details, /Browse Tools/);
  for (const width of [20, 40, 80, 120]) {
    for (const line of browser.render(width)) assert(visibleWidth(line) <= width);
  }
});

test('the selected MCP tab remains visible when category tabs exceed terminal width', async () => {
  const { renderTabs } = await import('../src/browser/render.ts');
  for (const width of [8, 20, 40, 80]) {
    const lines = renderTabs(theme, width, 'mcp');
    assert(lines.join('').includes('MCP'));
    assert(lines.every((line) => visibleWidth(line) <= width));
  }
});

test('Browse Server Tools filters exactly one namespace, without moving tools out of Tools', async () => {
  const { browser } = await browserFixture();
  browser.handleInput('mcp__docs__read');
  browser.handleInput('\r');
  browser.handleInput('\x1b[B');
  browser.handleInput('\x1b[B');
  browser.handleInput('\r');
  const output = browser.render(160).join('\n');
  assert.match(output, /Resources \/ Tools/);
  assert.match(output, /mcp:docs/);
  assert.equal(output.includes('docs_extra'), false);
});

test('MCP slash commands toggle config, retain add guidance and request reload', async () => {
  await save(userConfig, { mcpServers: { docs: { command: 'node' } } });
  const notices = [];
  const ctx = { cwd, isProjectTrusted: () => false, ui: { theme, getAllThemes: () => [], notify: (text) => notices.push(text) } };
  const provider = new ResourceCompletionProvider();
  assert((await provider.getArgumentCompletions('mc')).some((item) => item.value === 'mcp'));
  await handleAddCommand('mcp docs', ctx, async () => {});
  await handleMutateCommand('disable', 'mcp docs', ctx, async () => {}, runtime());
  assert(notices[0].includes('/mcp'));
  assert.match(notices[1], /Run \/reload/);
  assert.equal(JSON.parse(await readFile(userConfig, 'utf8')).mcpServers.docs.enabled, false);
  await handleMutateCommand('enable', 'mcp docs', ctx, async () => {}, runtime());
  assert.equal(JSON.parse(await readFile(userConfig, 'utf8')).mcpServers.docs.enabled, true);
});

test('file toggles preserve BOM, CRLF, indentation, credentials and unrelated settings', async () => {
  const config = { autoEnableCodemode: false, other: { keep: true }, mcpServers: {
    docs: { url: 'https://example.test', headers: { Authorization: '${SECRET}' }, oauth: { clientId: 'client' }, toolExposure: { search: 'direct' } },
    local: { command: 'node', args: ['--key', 'secret'], env: { TOKEN: 'secret' } },
  } };
  await writeFile(userConfig, '\uFEFF' + JSON.stringify(config, null, '\t').replace(/\n/g, '\r\n') + '\r\n', 'utf8');
  const item = (await discover()).find((item) => item.name === 'docs');
  const result = await setMcpServerEnabled(cwd, item, false, false, runtime());
  assert.equal(result.requiresReload, true);
  assert.equal(result.message.includes('SECRET'), false);
  const raw = await readFile(userConfig, 'utf8');
  assert(raw.startsWith('\uFEFF'));
  assert(raw.includes('\r\n\t"autoEnableCodemode"'));
  const saved = JSON.parse(raw.slice(1));
  config.mcpServers.docs.enabled = false;
  assert.deepEqual(saved, config);
  assert.equal((await discover()).find((item) => item.name === 'docs').configState, 'disabled');
});

test('project delta toggles update only the project enabled flag, preserving inheritance', async () => {
  await save(userConfig, { mcpServers: { docs: { url: 'https://example.test', enabled: false, headers: { Authorization: 'secret' } } } });
  const originalUser = await readFile(userConfig, 'utf8');
  await save(projectConfig, { mcpServers: { docs: { enabled: false, exposure: 'deferred' } }, other: true });
  const item = (await discover(true)).find((item) => item.name === 'docs');
  await assert.rejects(setMcpServerEnabled(cwd, item, true, false, runtime()), /not trusted/);
  await setMcpServerEnabled(cwd, item, true, true, runtime());
  assert.deepEqual(JSON.parse(await readFile(projectConfig, 'utf8')), { mcpServers: { docs: { enabled: true, exposure: 'deferred' } }, other: true });
  assert.equal(await readFile(userConfig, 'utf8'), originalUser);
  assert.equal((await discover(true)).find((item) => item.name === 'docs').enabled, true);
});

test('concurrent file toggles preserve independent server changes', async () => {
  await save(userConfig, { mcpServers: { a: { command: 'node' }, b: { command: 'node' } } });
  const items = await discover();
  await Promise.all(items.map((item) => setMcpServerEnabled(cwd, item, false, false, runtime())));
  const saved = JSON.parse(await readFile(userConfig, 'utf8'));
  assert.equal(saved.mcpServers.a.enabled, false);
  assert.equal(saved.mcpServers.b.enabled, false);
});

test('missing, malformed and stale rows never recreate or replace MCP configuration', async () => {
  await save(userConfig, { mcpServers: { docs: { command: 'node' } } });
  const item = (await discover())[0];
  await writeFile(userConfig, '{broken', 'utf8');
  await assert.rejects(setMcpServerEnabled(cwd, item, false, false, runtime()));
  assert.equal(await readFile(userConfig, 'utf8'), '{broken');
  await save(userConfig, { mcpServers: {} });
  await assert.rejects(setMcpServerEnabled(cwd, item, false, false, runtime()), /changed/);
  assert.deepEqual(JSON.parse(await readFile(userConfig, 'utf8')), { mcpServers: {} });
  await rm(userConfig);
  await assert.rejects(setMcpServerEnabled(cwd, item, false, false, runtime()), /changed/);
});

test('registration toggles use the API without copying server credentials into config', async () => {
  const registration = { name: 'owned', extensionPath: '/owner.ts', config: { command: 'node', env: { TOKEN: 'secret' } } };
  const host = { ...runtime([], [registration]), registerMcpServer(name, config) {
    assert.equal(name, 'owned');
    registration.config = config;
  } };
  const item = (await discover(false, host))[0];
  assert.equal(item.toggleMode, 'registration');
  const result = await setMcpServerEnabled(cwd, item, false, false, host);
  assert.equal(result.requiresReload, false);
  assert.equal(registration.config.enabled, false);
  assert.equal((await discover(false, host))[0].enabled, false);
  await assert.rejects(readFile(userConfig), /ENOENT/);
  const blocked = { ...host, registerMcpServer() { throw new Error('name belongs to another extension'); } };
  await assert.rejects(setMcpServerEnabled(cwd, item, true, false, blocked), /another extension/);
  assert.equal(registration.config.enabled, false);
});

test('runtime-only MCP namespaces retain a native-manager fallback, not a fake toggle', async () => {
  const host = runtime([tool('unknown')]);
  const item = (await discover(false, host))[0];
  assert.equal(item.toggleMode, 'none');
  assert.equal(getDetailActions(item).includes('toggle'), false);
  await assert.rejects(setMcpServerEnabled(cwd, item, false, false, host), /No editable MCP configuration/);
});

test('real Pi registry accepts owned enabled updates and rejects another extension ownership', async (t) => {
  const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = await import('@earendil-works/pi-coding-agent');
  let owner;
  let other;
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [
    { name: 'owner', factory(pi) { owner = pi; pi.registerMcpServer('owned', { command: 'node', enabled: false }); } },
    { name: 'other', factory(pi) { other = pi; } },
    // Observe registrations without starting subprocesses or network connections.
    { name: 'fixture-mcp', factory(pi) { pi.on('mcp_servers_change', async () => {}); } },
  ] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  const item = (await discover(false, owner))[0];
  await setMcpServerEnabled(cwd, item, true, false, owner);
  assert.equal(owner.getMcpServers()[0].config.enabled, true);
  await assert.rejects(setMcpServerEnabled(cwd, item, false, false, other), /another extension/);
  assert.equal(owner.getMcpServers()[0].config.enabled, true);
  await setMcpServerEnabled(cwd, item, false, false, owner);
  assert.equal(owner.getMcpServers()[0].config.enabled, false);
});

test('native manager handoff only expands an existing command, never a model prompt', () => {
  const sent = [];
  const notices = [];
  const ctx = { ui: { notify: (message) => notices.push(message) } };
  openNativeMcpManager({ ...runtime(), sendUserMessage: (...args) => sent.push(args), getCommands: () => [] }, ctx);
  assert.equal(sent.length, 0);
  assert.match(notices[0], /No \/mcp command/);
  openNativeMcpManager({ ...runtime(), sendUserMessage: (...args) => sent.push(args), getCommands: () => [{ name: 'mcp' }] }, ctx);
  assert.deepEqual(sent, [['/mcp', { expandPromptTemplates: true }]]);
});

test('browser saves MCP enabled state in place and applies auto reload only after closing', async () => {
  const { openResourceBrowser } = await import('../src/resource/browser-open.ts');
  await save(userConfig, { mcpServers: { docs: { command: 'node' } } });
  await save(join(agentDir, 'pi-resource-center-settings.json'), { reloadBehavior: 'auto' });
  let browser;
  let reloads = 0;
  let closed = false;
  const notices = [];
  const ctx = { mode: 'tui', cwd, isProjectTrusted: () => false, reload: async () => { assert.equal(closed, true); reloads++; },
    ui: { theme, getAllThemes: () => [], notify: (message) => notices.push(message),
      custom: (factory) => new Promise((resolve) => {
        browser = factory({ requestRender() {} }, theme, getKeybindings(), () => { closed = true; resolve(); });
      }) } };
  const opened = openResourceBrowser('mcp', ctx, runtime());
  for (let i = 0; !browser && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(browser);
  browser.handleInput(' ');
  for (let i = 0; !notices.some((message) => message.includes('/reload required')) && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(JSON.parse(await readFile(userConfig, 'utf8')).mcpServers.docs.enabled, false);
  assert.match(browser.render(160).join('\n'), /\[ \] docs/);
  assert.equal(closed, false);
  assert.equal(reloads, 0);
  assert(notices.some((message) => message.includes('/reload required')));
  browser.handleInput('\x1b');
  await opened;
  assert.equal(reloads, 1);
});

test('closing immediately after an MCP toggle waits for its config write and reload notice', async () => {
  const { openResourceBrowser } = await import('../src/resource/browser-open.ts');
  await save(userConfig, { mcpServers: { docs: { command: 'node' } } });
  let browser;
  const notices = [];
  const ctx = { mode: 'tui', cwd, isProjectTrusted: () => false,
    ui: { theme, getAllThemes: () => [], notify: (message) => notices.push(message),
      custom: (factory) => new Promise((resolve) => { browser = factory({ requestRender() {} }, theme, getKeybindings(), resolve); }) } };
  const opened = openResourceBrowser('mcp', ctx, runtime());
  for (let i = 0; !browser && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(browser);
  browser.handleInput(' ');
  browser.handleInput('\x1b');
  await opened;
  assert.equal(JSON.parse(await readFile(userConfig, 'utf8')).mcpServers.docs.enabled, false);
  assert(notices.some((message) => message.includes('Run /reload')));
});

test('open MCP browser refreshes delayed tools without rereading files and stops polling when closed', async (t) => {
  const { openResourceBrowser } = await import('../src/resource/browser-open.ts');
  await save(userConfig, { mcpServers: { docs: { command: 'node' } } });
  let tools = [];
  let reads = 0;
  let renders = 0;
  let browser;
  const host = { ...runtime(), getAllTools: () => { reads++; return tools; } };
  const ctx = { mode: 'tui', cwd, isProjectTrusted: () => false,
    ui: { theme, getAllThemes: () => [], notify() {}, custom: (factory) => new Promise((resolve) => {
      browser = factory({ requestRender: () => renders++ }, theme, getKeybindings(), resolve);
    }) } };
  const opened = openResourceBrowser('mcp', ctx, host);
  t.after(async () => { if (browser) browser.handleInput('\x1b'); await opened; });
  for (let i = 0; !browser && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(browser);
  assert.match(browser.render(160).join('\n'), /\[fetching tools…\]/);
  browser.handleInput('docs');
  browser.handleInput('\r');
  assert.match(browser.render(160).join('\n'), /Tools: Fetching tools…/);
  for (let i = 0; !browser.render(160).join('\n').includes('Tools: 0/0 active') && i < 150; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(browser.render(160).join('\n'), /Tools: 0\/0 active/);
  // File discovery would now produce a diagnostic. Runtime updates must not read this file.
  await writeFile(userConfig, '{broken', 'utf8');
  tools = [tool('docs'), tool('docs', 'read')];
  for (let i = 0; !browser.render(160).join('\n').includes('Tools: 0/2 active') && i < 150; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const output = browser.render(160).join('\n');
  assert.match(output, /Resources \/ MCP \/ docs/);
  assert.match(output, /Tools: 0\/2 active/);
  assert.equal(output.includes('Cannot read MCP configuration'), false);
  assert.equal(await readFile(userConfig, 'utf8'), '{broken');
  const unchangedRenders = renders;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(renders, unchangedRenders, 'unchanged inventories must not redraw');
  browser.handleInput('\x1b'); // details -> list; search must still be present
  assert.match(browser.render(160).join('\n'), /Search:.*docs/);
  browser.handleInput('\x1b');
  await opened;
  const closedReads = reads;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(reads, closedReads, 'closed browsers must not poll');
});

test('real Pi command flow closes Resource Center before opening native /mcp', async (t) => {
  const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { default: resourceCenter } = await import('../src/index.ts');
  let browser;
  let open = false;
  let managed = false;
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [resourceCenter, (pi) => {
    pi.registerCommand('mcp', { description: 'Fixture native manager', handler: async () => {
      assert.equal(open, false, 'native UI must not be nested inside the resource browser');
      managed = true;
    } });
  }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: 'tui', uiContext: { theme, getAllThemes: () => [], notify() {},
    custom: (factory) => new Promise((resolve) => {
      open = true;
      browser = factory({ requestRender() {} }, theme, getKeybindings(), () => { open = false; resolve(); });
    }) } });
  const command = session.prompt('/resource mcp');
  for (let i = 0; !browser && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(browser);
  browser.handleInput('M');
  await command;
  for (let i = 0; !managed && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(managed, true);
});
