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
const { discoverMcpServers, openNativeMcpManager } = await import('../src/resource/mcp.ts');
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

test('MCP browser has its own tab, honest config/resource labels and no resource toggle/remove actions', async () => {
  let managed = 0;
  const { browser, item } = await browserFixture({ onManageMcp: () => managed++ });
  assert.deepEqual(getDetailActions(item), ['mcp-manager', 'mcp-tools', 'pin', 'back']);
  assert.equal(canRemoveResourceIndividually(item), false);
  assert.match(browser.render(120).join('\n'), /\[config:on\]/);
  browser.handleInput(' ');
  assert.equal(managed, 1);
  assert.equal(item.enabled, true);
  browser.handleInput('M');
  assert.equal(managed, 2);
  browser.handleInput('\r');
  const details = browser.render(160).join('\n');
  assert.match(details, /not connection status/);
  assert.match(details, /Resources: not queried/);
  assert.match(details, /Browse Server Tools/);
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
  browser.handleInput('\r');
  const output = browser.render(160).join('\n');
  assert.match(output, /Resources \/ Tools/);
  assert.match(output, /mcp:docs/);
  assert.equal(output.includes('docs_extra'), false);
});

test('MCP is a slash-command category, while mutations are delegated to native /mcp', async () => {
  await save(userConfig, { mcpServers: { docs: { command: 'node' } } });
  const notices = [];
  const ctx = { cwd, isProjectTrusted: () => false, ui: { theme, getAllThemes: () => [], notify: (text) => notices.push(text) } };
  const provider = new ResourceCompletionProvider();
  assert((await provider.getArgumentCompletions('mc')).some((item) => item.value === 'mcp'));
  await handleAddCommand('mcp docs', ctx, async () => {});
  await handleMutateCommand('disable', 'mcp docs', ctx, async () => {}, runtime());
  assert(notices.every((text) => text.includes('/mcp')));
  assert.equal(JSON.parse(await readFile(userConfig, 'utf8')).mcpServers.docs.enabled, undefined);
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
