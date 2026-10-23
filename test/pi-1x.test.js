import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'pi-resource-center-1x-'));
const agentDir = join(home, 'agent');
const cwd = join(home, 'project');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { SettingsManager, DefaultResourceLoader, SessionManager, createAgentSession, getPackageDir,
  createCodemodeExtension, createToolSearchExtension } = await import('@earendil-works/pi-coding-agent');
const { discoverResources } = await import('../src/resource/discovery.ts');
const { buildToolResourceItems, getToolGroupId, getToolToggleMessage, setToolsEnabled } = await import('../src/resource/tool-runtime.ts');
const { setDefaultToolStates, toggleResourceInSettings, removeResourceFromSettings, removeConventionResource } = await import('../src/settings/mutations.ts');
const { canRemoveResourceIndividually } = await import('../src/resource/capabilities.ts');
const { getDetailActions, getDetailActionHint, getDetailActionLabel } = await import('../src/browser/actions.ts');
const { getSelectedTheme } = await import('../src/settings/shared.ts');

const settingsPath = join(agentDir, 'settings.json');
const projectSettingsPath = join(cwd, '.pi', 'settings.json');
const save = (path, settings) => writeFile(path, JSON.stringify(settings), 'utf8');
const readSettings = async (path = settingsPath) => JSON.parse(await readFile(path, 'utf8'));
const themeRuntime = { getAllThemes: () => [
  { name: 'system', path: undefined },
  { name: 'dark', path: join(getPackageDir(), 'dist', 'modes', 'interactive', 'theme', 'dark.json') },
  { name: 'light', path: join(getPackageDir(), 'dist', 'modes', 'interactive', 'theme', 'light.json') },
] };
const discover = (projectTrusted = false, theme) => discoverResources(cwd, theme, { projectTrusted, syncExternalSkills: false, themeRuntime });
const resolvedTools = (projectTrusted = false) => SettingsManager.create(cwd, agentDir, { projectTrusted }).getDefaultTools();

beforeEach(async () => {
  await Promise.all([rm(agentDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await save(settingsPath, {});
});
after(() => rm(home, { recursive: true, force: true }));

test('BOM-prefixed Pi settings, plugin settings, themes and frontmatter remain readable', async () => {
  const { readResourceCenterSettings } = await import('../src/settings/center.ts');
  const bom = (value) => `\uFEFF${JSON.stringify(value)}`;
  await writeFile(settingsPath, bom({ defaultTools: ['+codemode'] }), 'utf8');
  await writeFile(join(agentDir, 'pi-resource-center-settings.json'), bom({ sortMode: 'name' }), 'utf8');
  await mkdir(join(agentDir, 'themes'));
  await writeFile(join(agentDir, 'themes', 'bom.json'), bom({ name: 'bom-theme', colors: {} }), 'utf8');
  await mkdir(join(agentDir, 'skills', 'bom'), { recursive: true });
  await writeFile(join(agentDir, 'skills', 'bom', 'SKILL.md'), '\uFEFF---\nname: bom\ndescription: BOM skill\n---\nBody', 'utf8');
  const resources = await discover(false, 'bom-theme');
  assert.equal((await readResourceCenterSettings()).sortMode, 'name');
  assert.equal(resources.categories.themes.find((item) => item.name === 'bom-theme')?.enabled, true);
  assert.equal(resources.categories.skills.find((item) => item.name === 'bom')?.description, 'BOM skill');
  await setDefaultToolStates(cwd, [{ name: 'bash', enabled: false }], 'user', false);
  assert.deepEqual((await readSettings()).defaultTools, ['+codemode', '-bash']);
});

test('system is the default theme and cannot be shadowed by a custom theme', async () => {
  assert.equal(getSelectedTheme(undefined, undefined), 'system');
  await mkdir(join(agentDir, 'themes'));
  await save(join(agentDir, 'themes', 'shadow.json'), { name: 'system', colors: {} });
  const resources = await discover();
  const system = resources.categories.themes.filter((item) => item.name === 'system');
  assert.equal(system.length, 1);
  assert.equal(system[0].builtin, true);
  assert.equal(system[0].enabled, true);
  assert.equal(canRemoveResourceIndividually(system[0]), false);
  assert.equal((await discover(false, 'dark')).categories.themes.find((item) => item.name === 'system').enabled, false);
});

test('theme inventory follows Pi runtime additions instead of a built-in name list', async () => {
  const runtime = { getAllThemes: () => [
    { name: 'future-generated', path: undefined },
    { name: 'future-shipped', path: join(getPackageDir(), 'theme', 'future.json') },
  ] };
  const resources = await discoverResources(cwd, 'future-shipped', { projectTrusted: false, syncExternalSkills: false, themeRuntime: runtime });
  assert.deepEqual(resources.categories.themes.map((item) => item.name).sort(), ['future-generated', 'future-shipped']);
  for (const item of resources.categories.themes) {
    assert.equal(item.builtin, true);
    assert.equal(item.path, undefined, 'shipped files must never become removable user resources');
    assert.equal(canRemoveResourceIndividually(item), false);
    assert.deepEqual(getDetailActions(item), ['toggle', 'pin', 'back']);
  }
  assert.equal(resources.categories.themes.find((item) => item.name === 'future-shipped').enabled, true);
  const withoutRuntime = await discoverResources(cwd, undefined, { projectTrusted: false, syncExternalSkills: false });
  assert.deepEqual(withoutRuntime.categories.themes, [], 'headless discovery must not fabricate a built-in list');
});

test('runtime themes merge by path without losing project package metadata or active summaries', async () => {
  const packageDir = join(cwd, 'theme-package');
  const themePath = join(packageDir, 'themes', 'paper.json');
  await mkdir(join(packageDir, 'themes'), { recursive: true });
  await save(join(packageDir, 'package.json'), { name: 'theme-fixture', pi: { themes: ['./themes'] } });
  await save(themePath, { name: 'disk-name', colors: {} });
  await save(projectSettingsPath, { packages: [packageDir] });
  const runtime = { getAllThemes: () => [{ name: 'loaded-name', path: themePath }] };
  const resources = await discoverResources(cwd, 'loaded-name', { projectTrusted: true, syncExternalSkills: false, themeRuntime: runtime });
  assert.equal(resources.categories.themes.length, 1);
  const theme = resources.categories.themes[0];
  assert.equal(theme.name, 'loaded-name');
  assert.equal(theme.scope, 'project');
  assert.equal(theme.packageSource, packageDir);
  assert.equal(theme.packageRelativePath, 'themes/paper.json');
  assert.equal(theme.enabled, true);
  assert.deepEqual(resources.categories.packages[0].enabledSummary, { enabledCount: 1, totalCount: 1 });
  const original = await discoverResources(cwd, 'disk-name', { projectTrusted: true, syncExternalSkills: false });
  assert.equal(theme.id, original.categories.themes[0].id, 'runtime merging must preserve stable resource identities');
});

test('runtime-only file themes are included without pretending they are configured resources', async () => {
  const themePath = join(cwd, 'cli-theme.json');
  await save(themePath, { name: 'cli-theme', colors: {} });
  const resources = await discoverResources(cwd, 'cli-theme', { projectTrusted: false, syncExternalSkills: false,
    themeRuntime: { getAllThemes: () => [{ name: 'cli-theme', path: themePath }] } });
  const theme = resources.categories.themes[0];
  assert.equal(theme.source, 'runtime');
  assert.equal(theme.path, themePath);
  assert.equal(theme.enabled, true);
  assert.equal(canRemoveResourceIndividually(theme), false);
  assert.deepEqual(getDetailActions(theme), ['toggle', 'pin', 'back']);
});

test('only the runtime-selected file is active when discovered themes share a name', async () => {
  const themeDir = join(agentDir, 'themes');
  await mkdir(themeDir);
  const winner = join(themeDir, 'winner.json');
  const shadowed = join(themeDir, 'shadowed.json');
  await save(winner, { name: 'shared-name', colors: {} });
  await save(shadowed, { name: 'shared-name', colors: {} });
  const resources = await discoverResources(cwd, 'shared-name', { projectTrusted: false, syncExternalSkills: false,
    themeRuntime: { getAllThemes: () => [{ name: 'shared-name', path: winner }] } });
  assert.equal(resources.categories.themes.length, 2);
  assert.deepEqual(resources.categories.themes.filter((item) => item.enabled).map((item) => item.path), [winner]);
});

test('first-use slash completions and theme commands receive the live UI theme inventory', async () => {
  const resourceCenter = (await import('../src/index.ts')).default;
  const handlers = new Map();
  let command;
  let applied;
  const ui = { theme: { name: 'system' }, getAllThemes: () => [{ name: 'future-theme', path: undefined }],
    getTheme: () => ({}), setTheme: (name) => { applied = name; return { success: true }; }, notify() {} };
  const pi = { registerCommand(_name, definition) { command = definition; }, on(name, handler) { handlers.set(name, handler); },
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {} };
  resourceCenter(pi);
  const ctx = { cwd, ui, isProjectTrusted: () => false };
  await handlers.get('session_start')({}, ctx);
  const completions = await command.getArgumentCompletions('enable theme future');
  assert(completions.some((item) => item.value === 'enable theme future-theme'));
  await command.handler('enable theme future-theme', ctx);
  assert.equal(applied, 'future-theme');
  assert.equal((await readSettings()).theme, 'future-theme');
});

test('discovers built-in extensions, including disabled ones, without filesystem paths', async () => {
  await save(settingsPath, { extensions: ['-builtin:mcp'] });
  const items = (await discover()).categories.extensions;
  assert.deepEqual(items.map((item) => item.name).sort(), ['builtin:codemode', 'builtin:llama.cpp', 'builtin:mcp', 'builtin:tool-search']);
  const mcp = items.find((item) => item.name === 'builtin:mcp');
  assert.equal(mcp.enabled, false);
  assert.equal(mcp.path, 'builtin:mcp');
  assert.equal(mcp.source, 'builtin');
  assert.equal(mcp.scope, 'user');
  assert.equal(mcp.updatedAt, 0);
  assert.deepEqual(getDetailActions(mcp), ['toggle', 'pin', 'back']);
  assert.equal(canRemoveResourceIndividually(mcp), false);
  await assert.rejects(removeResourceFromSettings(cwd, mcp, false), /Built-in extensions cannot be removed/);
  await assert.rejects(removeConventionResource(mcp), /no file to delete/);
});

test('built-in extension toggles preserve unrelated filters and round-trip through Pi discovery', async () => {
  await save(settingsPath, { extensions: ['!**/legacy.ts', '-builtin:mcp'] });
  let mcp = (await discover()).categories.extensions.find((item) => item.name === 'builtin:mcp');
  mcp.enabled = true;
  await toggleResourceInSettings(cwd, mcp, false);
  assert.deepEqual((await readSettings()).extensions, ['!**/legacy.ts', '+builtin:mcp']);
  mcp = (await discover()).categories.extensions.find((item) => item.name === 'builtin:mcp');
  assert.equal(mcp.enabled, true);
  mcp.enabled = false;
  await toggleResourceInSettings(cwd, mcp, false);
  assert.deepEqual((await readSettings()).extensions, ['!**/legacy.ts', '-builtin:mcp']);
  assert.equal((await discover()).categories.extensions.find((item) => item.name === 'builtin:mcp').enabled, false);
});

test('project built-in extension overrides apply only after trust', async () => {
  await save(settingsPath, { extensions: ['-builtin:mcp'] });
  await save(projectSettingsPath, { extensions: ['+builtin:mcp'] });
  const untrusted = (await discover()).categories.extensions.find((item) => item.name === 'builtin:mcp');
  assert.equal(untrusted.enabled, false);
  assert.equal(untrusted.scope, 'user');
  const trusted = (await discover(true)).categories.extensions.find((item) => item.name === 'builtin:mcp');
  assert.equal(trusted.enabled, true);
  assert.equal(trusted.scope, 'project');
  trusted.enabled = false;
  await assert.rejects(toggleResourceInSettings(cwd, trusted, false), /Project is not trusted/);
  await toggleResourceInSettings(cwd, trusted, true);
  assert.deepEqual((await readSettings(projectSettingsPath)).extensions, ['-builtin:mcp']);
  assert.deepEqual((await readSettings()).extensions, ['-builtin:mcp']);
});

test('defaultTools changes preserve unrelated modifiers and inherited defaults', async () => {
  await save(settingsPath, { theme: 'system', defaultTools: ['+codemode', '+tool_search', '-bash'] });
  await setDefaultToolStates(cwd, [{ name: 'grep', enabled: true }], 'user', false);
  assert.deepEqual((await readSettings()).defaultTools, ['+codemode', '+tool_search', '-bash', '+grep']);
  assert.equal((await readSettings()).theme, 'system');
  assert.deepEqual(resolvedTools(), ['read', 'edit', 'write', 'codemode', 'tool_search', 'grep']);
});

test('project defaultTools deltas do not flatten user settings', async () => {
  await save(settingsPath, { defaultTools: ['+codemode', '-bash'] });
  await save(projectSettingsPath, { defaultTools: ['-write'] });
  await setDefaultToolStates(cwd, [{ name: 'powershell', enabled: true }], 'project', true);
  assert.deepEqual((await readSettings(projectSettingsPath)).defaultTools, ['-write', '+powershell']);
  assert.deepEqual(resolvedTools(true), ['read', 'edit', 'codemode', 'powershell']);
  assert.deepEqual((await readSettings()).defaultTools, ['+codemode', '-bash']);
});

test('an explicit empty defaultTools list stays empty instead of restoring the defaults', async () => {
  await save(settingsPath, { defaultTools: [] });
  await setDefaultToolStates(cwd, [{ name: 'bash', enabled: false }], 'user', false);
  assert.deepEqual((await readSettings()).defaultTools, []);
  assert.deepEqual(resolvedTools(), []);
  await setDefaultToolStates(cwd, [{ name: 'grep', enabled: true }], 'user', false);
  assert.deepEqual(resolvedTools(), ['grep']);
});

test('disabling the last plain tool retains allowlist semantics', async () => {
  await save(settingsPath, { defaultTools: ['read'] });
  await setDefaultToolStates(cwd, [{ name: 'read', enabled: false }], 'user', false);
  assert.deepEqual((await readSettings()).defaultTools, ['read', '-read']);
  assert.deepEqual(resolvedTools(), []);
  await setDefaultToolStates(cwd, [{ name: 'read', enabled: true }], 'user', false);
  assert.deepEqual(resolvedTools(), ['read']);
});

test('concurrent defaultTools mutations preserve both changes', async () => {
  await save(settingsPath, { defaultTools: ['+codemode'] });
  await Promise.all([
    setDefaultToolStates(cwd, [{ name: 'bash', enabled: false }], 'user', false),
    setDefaultToolStates(cwd, [{ name: 'grep', enabled: true }], 'user', false),
  ]);
  assert.deepEqual(resolvedTools(), ['read', 'edit', 'write', 'codemode', 'grep']);
});

test('tool toggles persist only the requested change, not CLI/session active-tool snapshots', async () => {
  await save(settingsPath, { defaultTools: ['+codemode', '+tool_search'] });
  const all = ['bash', 'grep'].map((name) => ({ name, description: name, exposure: 'direct',
    sourceInfo: { source: 'builtin', path: `builtin:${name}`, origin: 'top-level', scope: 'temporary' } }));
  let active = [];
  const runtime = { getAllTools: () => all, getActiveTools: () => [...active], setActiveTools: (names) => { active = names; } };
  const items = buildToolResourceItems(all, [], 'user');
  await Promise.all([
    setToolsEnabled(runtime, [items[0]], true, cwd, false),
    setToolsEnabled(runtime, [items[1]], true, cwd, false),
  ]);
  assert.deepEqual(active, ['bash', 'grep']);
  assert.deepEqual((await readSettings()).defaultTools, ['+codemode', '+tool_search', '+bash', '+grep']);
  assert(resolvedTools().includes('read'), 'an inactive CLI/session tool must not be removed from startup defaults');
});

test('real Pi runtime: MCP tools are session-only, namespaced, and callable even when inactive', async () => {
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
    extensionFactories: [
      { name: 'codemode', builtin: true, factory: createCodemodeExtension() },
      { name: 'tool-search', builtin: true, factory: createToolSearchExtension() },
      { name: 'mcp', builtin: true, factory(pi) {
        for (const [server, exposure] of [['docs', 'codemode'], ['files', 'deferred'], ['direct', 'direct'], ['withdrawn', 'hidden']]) {
          pi.registerTool({ name: `mcp__${server}__search`, label: 'Search', description: 'Fixture tool',
            parameters: { type: 'object', properties: {} }, exposure, namespace: { name: `mcp__${server}` },
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }) });
        }
        pi.registerTool({ name: 'list_mcp_resources', label: 'Resources', description: 'List resources',
          parameters: { type: 'object', properties: {} }, exposure: 'codemode',
          execute: async () => ({ content: [], details: undefined }) });
      } },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
    sessionManager: SessionManager.inMemory(cwd) });
  try {
    await session.bindExtensions({});
    const runtime = { getAllTools: () => session.getAllTools(), getActiveTools: () => session.getActiveToolNames(),
      setActiveTools: (names) => session.setActiveToolsByName(names) };
    const items = buildToolResourceItems(runtime.getAllTools(), runtime.getActiveTools(), 'user');
    const codemode = items.find((item) => item.name === 'codemode');
    const toolSearch = items.find((item) => item.name === 'tool_search');
    assert.equal(codemode.builtin, true);
    assert.equal(codemode.persistent, true);
    assert.equal(toolSearch.persistent, true);
    const resourceTool = items.find((item) => item.name === 'list_mcp_resources');
    assert.equal(resourceTool.builtin, false);
    assert.equal(resourceTool.sourceLabel, 'builtin:mcp');
    assert.notEqual(getToolGroupId(resourceTool), getToolGroupId(codemode));
    assert.equal(items.some((item) => item.name.includes('withdrawn')), false);
    const docs = items.find((item) => item.name === 'mcp__docs__search');
    const files = items.find((item) => item.name === 'mcp__files__search');
    assert.equal(docs.source, 'builtin', 'the real host reports builtin as the MCP extension source');
    assert.equal(docs.builtin, false);
    assert.equal(docs.persistent, false);
    assert.equal(docs.sourceLabel, 'mcp:docs');
    assert.notEqual(getToolGroupId(docs), getToolGroupId(files));
    for (const item of [docs, files]) {
      await setToolsEnabled(runtime, [item], true, cwd, false);
      assert(runtime.getActiveTools().includes(item.name));
      await setToolsEnabled(runtime, [item], false, cwd, false);
      assert.equal(runtime.getActiveTools().includes(item.name), false);
      assert(session.getCallableToolNames().includes(item.name));
      assert.match(getToolToggleMessage(item, false), /still callable/);
    }
    assert.deepEqual(await readSettings(), {}, 'MCP toggles must not write defaultTools');
    await setToolsEnabled(runtime, [codemode], true, cwd, false);
    assert.deepEqual((await readSettings()).defaultTools, ['+codemode']);
    const direct = items.find((item) => item.name === 'mcp__direct__search');
    await setToolsEnabled(runtime, [direct], false, cwd, false);
    assert.equal(session.getCallableToolNames().includes(direct.name), false);
  } finally {
    session.dispose();
  }
});

test('deferred tool actions describe activation rather than promising to disable access', () => {
  const theme = { fg: (_color, text) => text };
  const item = { category: 'tools', enabled: true, exposure: 'deferred', persistent: false };
  assert.equal(getDetailActionLabel(theme, 'toggle', item, { isPinned: false, selected: false }), 'Deactivate');
  assert.match(getDetailActionHint(theme, 'toggle', item, { isPinned: false, confirmingRemove: false }), /still callable/);
});

test('the browser stays TUI-only in RPC, JSON and print modes', async () => {
  const { openResourceBrowser } = await import('../src/resource/browser-open.ts');
  for (const mode of ['rpc', 'json', 'print']) {
    const notices = [];
    await openResourceBrowser('tools', { mode, ui: { notify: (message) => notices.push(message) } }, {});
    assert.match(notices[0], /only available in interactive TUI mode/);
  }
});
