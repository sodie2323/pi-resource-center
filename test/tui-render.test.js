import test from 'node:test';
import assert from 'node:assert/strict';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { ResourceBrowser } from '../src/browser/browser.ts';
import { getDetailActions } from '../src/browser/actions.ts';
import { renderDescriptionBlock } from '../src/browser/render.ts';
import { buildBrowserListEntries } from '../src/browser/selectors.ts';
import { buildToolResourceItems } from '../src/resource/tool-runtime.ts';
import { DEFAULT_RESOURCE_CENTER_SETTINGS } from '../src/settings/shared.ts';

const passthroughTheme = new Proxy({
  name: 'dark',
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
}, {
  get(target, property) {
    return property in target ? target[property] : ((text) => text);
  },
});

const packageItem = {
  category: 'packages',
  id: 'package:user:local:pi-ralph',
  name: 'D:/Dev/pi-ralph',
  scope: 'user',
  source: 'D:/Dev/pi-ralph',
  description: 'Ralph package',
  enabled: true,
  version: '0.1.0',
  enabledSummary: { enabledCount: 2, totalCount: 2 },
};

const emptyResources = {
  categories: {
    packages: [],
    skills: [],
    extensions: [],
    prompts: [],
    themes: [],
    tools: [],
    mcp: [],
  },
};

test('tools are individual resources grouped by their runtime source', () => {
  const tools = buildToolResourceItems([
    { name: 'read', description: 'Read files', parameters: {}, sourceInfo: { path: '<builtin:read>', source: 'builtin', scope: 'temporary', origin: 'top-level' } },
    { name: 'bash', description: 'Run Bash', parameters: {}, sourceInfo: { path: '<builtin:bash>', source: 'builtin', scope: 'temporary', origin: 'top-level' } },
    { name: 'search', description: 'Search remotely', parameters: {}, sourceInfo: { path: 'D:/ext/index.ts', source: 'npm:example-tools', scope: 'user', origin: 'package', baseDir: 'D:/ext' } },
    { name: 'read', description: 'Remote read', parameters: {}, sourceInfo: { path: 'C:/agent/extensions/ssh.ts', source: 'auto', scope: 'user', origin: 'top-level' } },
  ], ['read', 'search'], 'project');

  const override = tools.find((tool) => tool.overridesBuiltin);
  assert(override, 'overridden builtin should be detected');
  assert(override.description.includes('overrides the built-in read tool'));

  assert.deepEqual(tools.filter((tool) => !tool.overridesBuiltin).map(({ name, enabled, scope, persistent }) => ({ name, enabled, scope, persistent })), [
    { name: 'read', enabled: true, scope: 'project', persistent: true },
    { name: 'bash', enabled: false, scope: 'project', persistent: true },
    { name: 'search', enabled: true, scope: 'user', persistent: false },
  ]);

  const collapsed = buildBrowserListEntries('tools', tools, new Set());
  assert.equal(collapsed[0].kind, 'resource-group');
  assert.equal(collapsed[0].groupName, 'builtin');
  assert.equal(collapsed[0].enabledCount, 1);
  assert.equal(collapsed[0].totalCount, 2);
  assert.equal(collapsed[1].kind, 'resource');

  const expanded = buildBrowserListEntries('tools', tools, new Set([collapsed[0].groupId]));
  assert.deepEqual(expanded.map((entry) => entry.kind), ['resource-group', 'resource-child', 'resource-child', 'resource', 'resource']);
});

test('builtin tool group stays first regardless of sort order', () => {
  const tools = buildToolResourceItems([
    { name: 'read', description: 'Read files', parameters: {}, sourceInfo: { path: '<builtin:read>', source: 'builtin', scope: 'temporary', origin: 'top-level' } },
    { name: 'bash', description: 'Run Bash', parameters: {}, sourceInfo: { path: '<builtin:bash>', source: 'builtin', scope: 'temporary', origin: 'top-level' } },
    { name: 'a_search', description: 'Sorts first', parameters: {}, sourceInfo: { path: 'D:/npm/x/index.ts', source: 'npm:x', scope: 'user', origin: 'package' } },
  ], ['read'], 'user');
  const entries = buildBrowserListEntries('tools', tools, new Set());
  assert.equal(entries[0].kind, 'resource-group');
  assert.equal(entries[0].groupName, 'builtin');
  assert.equal(entries[entries.length - 1].kind, 'resource');
  assert.equal(entries[entries.length - 1].item.name, 'a_search');
});

test('tools browser renders source groups and dispatches group toggles', () => {
  const tools = buildToolResourceItems([
    { name: 'read', description: 'Read files', parameters: {}, sourceInfo: { path: '<builtin:read>', source: 'builtin', scope: 'temporary', origin: 'top-level' } },
    { name: 'bash', description: 'Run Bash', parameters: {}, sourceInfo: { path: '<builtin:bash>', source: 'builtin', scope: 'temporary', origin: 'top-level' } },
    { name: 'preview', description: 'Preview', parameters: {}, sourceInfo: { path: 'D:/npm/preview/index.ts', source: 'npm:preview', scope: 'user', origin: 'package' } },
  ], ['read'], 'user');
  let toggled;
  const browser = new ResourceBrowser(
    passthroughTheme,
    { ...emptyResources, categories: { ...emptyResources.categories, tools } },
    'tools',
    structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS),
    { onClose() {}, onToggleGroup(items, enabled, label) { toggled = { items, enabled, label }; } },
    process.cwd(),
    getKeybindings(),
  );
  const rendered = browser.render(100).join('\n');
  assert(rendered.includes('[1/2]'));
  assert(rendered.includes('builtin'));
  assert(rendered.includes('[session]'));
  assert.equal(rendered.includes('Builtins persist'), false);
  assert.equal(rendered.includes('A add'), false);
  browser.handleInput(' ');
  assert.equal(toggled.enabled, true);
  assert.equal(toggled.label, 'builtin');
  assert.deepEqual([...toggled.items.map((item) => item.name)].sort(), ['bash', 'read']);

  const extensionTools = buildToolResourceItems([
    { name: 'search', description: 'Search', parameters: {}, sourceInfo: { path: 'D:/npm/preview/index.ts', source: 'npm:preview', scope: 'user', origin: 'package' } },
    { name: 'render', description: 'Render', parameters: {}, sourceInfo: { path: 'D:/npm/preview/index.ts', source: 'npm:preview', scope: 'user', origin: 'package' } },
  ], [], 'user');
  const extensionBrowser = new ResourceBrowser(
    passthroughTheme,
    { ...emptyResources, categories: { ...emptyResources.categories, tools: extensionTools } },
    'tools',
    structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS),
    { onClose() {} },
    process.cwd(),
    getKeybindings(),
  );
  const extensionRendered = extensionBrowser.render(100).join('\n');
  assert(extensionRendered.includes('npm:preview [session]'));
});
test('package details retain the documented whole-package toggle', () => {
  assert.deepEqual(getDetailActions(packageItem), ['manage', 'toggle', 'pin', 'update', 'remove', 'back']);
});

test('search matches the formatted source labels visible in the list', () => {
  const browser = new ResourceBrowser(
    passthroughTheme,
    { ...emptyResources, categories: { ...emptyResources.categories, packages: [packageItem] } },
    'packages',
    structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS),
    { onClose() {} },
    process.cwd(),
    getKeybindings(),
  );
  browser.handleInput('local');
  assert(browser.render(100).some((line) => line.includes('local:pi-ralph')));
});

test('detail pages omit redundant resource metadata fields', () => {
  const browser = new ResourceBrowser(
    passthroughTheme,
    { ...emptyResources, categories: { ...emptyResources.categories, packages: [packageItem] } },
    'packages',
    structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS),
    { onClose() {} },
    process.cwd(),
    getKeybindings(),
  );
  browser.handleInput('\r');
  const rendered = browser.render(100).join('\n');
  for (const label of ['Category:', 'Enabled:', 'Pinned:', 'Scope:', 'Name:', 'Source:', 'Path:']) {
    assert.equal(rendered.includes(label), false, `unexpected detail field: ${label}`);
  }
  assert(rendered.includes('Description'));
  assert(rendered.includes('Actions'));
});

test('description blocks remove edge blank lines while preserving paragraphs and indentation', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = ['', '  ', 'First paragraph', '', '    indented example', 'Last paragraph', ' \t', ''].join(newline);
    assert.deepEqual(renderDescriptionBlock(passthroughTheme, text, 100), [
      '  First paragraph', '  ', '      indented example', '  Last paragraph',
    ]);
  }
  assert.deepEqual(renderDescriptionBlock(passthroughTheme, '  indented first line', 100), ['    indented first line']);
  assert.deepEqual(renderDescriptionBlock(passthroughTheme, '\r\n \t\n', 100), []);
});

test('all resource details use only one blank line before Description and none before its content', () => {
  const file = { id: 'file:example', name: 'example', scope: 'user', source: 'auto', enabled: true, path: '/example.md' };
  const items = [
    packageItem,
    { ...file, category: 'skills' },
    { ...file, category: 'extensions' },
    { ...file, category: 'prompts', argumentHint: '<input>' },
    { ...file, category: 'themes' },
    ...buildToolResourceItems([{ name: 'read', description: '', parameters: {},
      sourceInfo: { path: 'builtin:read', source: 'builtin', scope: 'temporary', origin: 'top-level' } }], ['read'], 'user'),
    mcpServer,
  ];
  for (const item of items) {
    const browser = new ResourceBrowser(passthroughTheme,
      { categories: { ...emptyResources.categories, [item.category]: [{ ...item, description: '\n \nFirst paragraph\n\nLast paragraph\n\n' }] } },
      item.category, structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS), { onClose() {} }, process.cwd(), getKeybindings());
    browser.handleInput('\r');
    const lines = browser.render(120);
    const heading = lines.findIndex((line) => line.trim() === 'Description');
    assert(heading >= 2, item.category);
    assert.equal(lines[heading - 1].trim(), '', item.category);
    assert.notEqual(lines[heading - 2].trim(), '', `${item.category}: no stacked blank lines`);
    assert.equal(lines[heading + 1].trim(), 'First paragraph', item.category);
    assert.equal(lines[heading + 2].trim(), '', `${item.category}: keep paragraph break`);
    assert.equal(lines[heading + 3].trim(), 'Last paragraph', item.category);
    assert.equal(lines[heading + 4].trim(), '', item.category);
    assert.equal(lines[heading + 5].trim(), 'Actions', `${item.category}: no trailing blank lines`);
  }
});

test('empty descriptions do not leave an empty heading or extra leading spacer', () => {
  const item = { category: 'themes', id: 'theme:empty', name: 'empty', enabled: false, scope: 'user', source: 'auto', description: '\n \t\n' };
  const browser = new ResourceBrowser(passthroughTheme, { categories: { ...emptyResources.categories, themes: [item] } },
    'themes', structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS), { onClose() {} }, process.cwd(), getKeybindings());
  browser.handleInput('\r');
  const lines = browser.render(100);
  assert.equal(lines.some((line) => line.trim() === 'Description'), false);
  const actions = lines.findIndex((line) => line.trim() === 'Actions');
  assert.equal(lines[actions - 1].trim(), '');
  assert.notEqual(lines[actions - 2].trim(), '');
});

test('tool exposure badges are rendered and searchable without merging MCP servers into builtins', () => {
  const tools = buildToolResourceItems([
    { name: 'mcp__docs__search', description: 'Search docs', exposure: 'deferred', namespace: { name: 'mcp__docs' },
      sourceInfo: { path: 'builtin:mcp', source: 'builtin', scope: 'user', origin: 'top-level' } },
    { name: 'read', description: 'Read', exposure: 'direct',
      sourceInfo: { path: 'builtin:read', source: 'builtin', scope: 'temporary', origin: 'top-level' } },
  ], ['read'], 'user');
  const browser = new ResourceBrowser(
    passthroughTheme,
    { ...emptyResources, categories: { ...emptyResources.categories, tools } },
    'tools',
    structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS),
    { onClose() {} },
    process.cwd(),
    getKeybindings(),
  );
  const rendered = browser.render(120).join('\n');
  assert(rendered.includes('[deferred]'));
  assert(rendered.includes('mcp:docs'));
  browser.handleInput('deferred');
  const filtered = browser.render(120).join('\n');
  assert(filtered.includes('mcp__docs__search'));
  assert.equal(filtered.includes(' builtin'), false);
  for (const width of [20, 40, 80, 120]) {
    for (const line of browser.render(width)) assert(visibleWidth(line) <= width);
  }
});

const mcpServer = {
  category: 'mcp', id: 'mcp:mcp__docs', name: 'docs', scope: 'user',
  source: '/agent/mcp.json', sourceLabel: 'user:mcp.json', description: 'Search project documentation.',
  enabled: true, configState: 'enabled', toggleMode: 'config', transport: 'stdio', exposure: 'codemode',
  namespace: 'mcp__docs', toolNames: ['mcp__docs__search', 'mcp__docs__read'], activeToolCount: 1,
  resourceTools: ['list_mcp_resources', 'read_mcp_resource'],
};

function createMcpBrowser(items, theme = passthroughTheme) {
  return new ResourceBrowser(theme,
    { categories: { ...emptyResources.categories, mcp: items } }, 'mcp',
    structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS), { onClose() {} }, process.cwd(), getKeybindings());
}

test('MCP rows share checkbox colors, compact summaries, scope and source layout with other resources', () => {
  const colors = [];
  const theme = new Proxy({ ...passthroughTheme, fg: (color, text) => { colors.push([color, text]); return text; } }, {
    get: (target, key) => key in target ? target[key] : (text) => text,
  });
  const variants = [
    mcpServer,
    { ...mcpServer, id: 'disabled', name: 'disabled', enabled: false, configState: 'disabled' },
    { ...mcpServer, id: 'registered', name: 'registered', scope: 'session', toggleMode: 'registration' },
    { ...mcpServer, id: 'unknown', name: 'unknown', configState: 'unknown', toggleMode: 'none' },
    { ...mcpServer, id: 'invalid', name: 'invalid', configState: 'error', toggleMode: 'none', toolNames: [] },
  ];
  const browser = createMcpBrowser(variants, theme);
  const lines = browser.render(140);
  const output = lines.join('\n');
  assert.match(output, /\[x\] docs \[2 tools\]/);
  const disabledRow = lines.find((line) => line.includes('[ ] disabled'));
  assert(disabledRow);
  assert.equal(disabledRow.includes('tools'), false);
  assert.match(output, /registered \[session\] \[2 tools\]/);
  assert.match(output, /\[\?\] unknown/);
  assert.match(output, /\[!\] invalid/);
  assert.match(lines.find((line) => line.includes('[x] docs')), /user\s+user:mcp\.json/);
  assert(colors.some(([color, text]) => color === 'success' && text === '[x]'));
  assert(colors.some(([color, text]) => color === 'dim' && text === '[ ]'));
  assert(colors.some(([color, text]) => color === 'dim' && text === '[?]'));
  assert(colors.some(([color, text]) => color === 'error' && text === '[!]'));
  assert.equal(output.includes('[config:'), false);
  assert.equal(output.includes('visible tools'), false);
  for (const width of [20, 40, 80, 120]) {
    for (const line of browser.render(width)) assert(visibleWidth(line) <= width);
  }
});

test('MCP details use common field styling and Description/Actions sections without technical inventory clutter', () => {
  const colors = [];
  const theme = new Proxy({ ...passthroughTheme, fg: (color, text) => { colors.push([color, text]); return text; } }, {
    get: (target, key) => key in target ? target[key] : (text) => text,
  });
  const browser = createMcpBrowser([mcpServer], theme);
  browser.handleInput('\r');
  const output = browser.render(140).join('\n');
  assert.match(output, /Tools: 1\/2 active · registered/);
  assert.match(output, /Transport: stdio · Exposure: codemode/);
  assert.match(output, /Resources: Not queried · shared access available/);
  assert.match(output, /not connection status/);
  assert.match(output, /Description\n/);
  assert.match(output, /Actions\n/);
  assert.match(output, /Open MCP Manager/);
  assert.match(output, /Browse Tools/);
  for (const label of ['Tools', 'Transport', 'Resources', 'Exposure']) {
    assert(colors.some(([color, text]) => color === 'muted' && text === label));
  }
  for (const text of ['Config:', 'Source:', 'Scope:', 'mcp__docs__search', 'list_mcp_resources', 'Pi UI API', 'Shared access:']) {
    assert.equal(output.includes(text), false, `unexpected detail clutter: ${text}`);
  }
  for (const width of [20, 40, 80, 120]) {
    for (const line of browser.render(width)) assert(visibleWidth(line) <= width);
  }
});

test('MCP footer distinguishes editable switches from unknown-state native management', () => {
  const editable = createMcpBrowser([mcpServer]);
  assert.match(editable.render(160).join('\n'), /Space toggle · P pin\/unpin · Enter details · M manage/);
  const unknown = createMcpBrowser([{ ...mcpServer, configState: 'unknown', toggleMode: 'none' }]);
  assert.match(unknown.render(160).join('\n'), /Space manage/);
  unknown.handleInput('\r');
  assert.equal(unknown.render(160).join('\n').includes('› Enable'), false);
  assert.equal(unknown.render(160).join('\n').includes('› Disable'), false);
});

const rawMcpTool = (name, exposure = 'codemode') => ({
  name: `mcp__docs__${name}`, description: name, exposure, namespace: { name: 'mcp__docs' },
  sourceInfo: { source: 'builtin', path: 'builtin:mcp', scope: 'temporary', origin: 'top-level' },
});

test('MCP inventory transitions from fetching to zero and then late tools, with no perpetual unknown state', () => {
  const browser = createMcpBrowser([{ ...mcpServer, toolNames: [], toolsLoading: true, activeToolCount: 0 }]);
  const list = browser.render(160).join('\n');
  assert.match(list, /\[fetching tools…\]/);
  assert.equal(list.includes('[0 tools]'), false);
  browser.handleInput('\r');
  assert.match(browser.render(160).join('\n'), /Tools: Fetching tools…/);
  browser.setRuntimeTools([], []);
  assert.match(browser.render(160).join('\n'), /Tools: 0\/0 active · registered/);
  browser.handleInput('\x1b');
  assert.match(browser.render(160).join('\n'), /\[0 tools\]/);
  assert.equal(browser.render(160).join('\n').includes('fetching'), false);
  browser.setRuntimeTools([rawMcpTool('read')], []);
  assert.match(browser.render(160).join('\n'), /\[1 tools\]/);
  browser.setRuntimeTools([], []);
  assert.match(browser.render(160).join('\n'), /\[0 tools\]/);
  const disabled = createMcpBrowser([{ ...mcpServer, enabled: false, configState: 'disabled', toolNames: [], activeToolCount: 0 }]);
  const row = disabled.render(160).find((line) => line.includes('[ ] docs'));
  assert(row);
  assert.equal(row.includes('tools'), false);
  disabled.handleInput('\r');
  assert.match(disabled.render(160).join('\n'), /disabled in configuration/);
});

test('runtime updates preserve the selected server by identity when a new row is inserted', () => {
  const second = { ...mcpServer, id: 'mcp:mcp__zeta', name: 'zeta', namespace: 'mcp__zeta', toolNames: [] };
  const browser = createMcpBrowser([mcpServer, second]);
  browser.handleInput('\x1b[B');
  browser.setRuntimeTools([rawMcpTool('read'), { ...rawMcpTool('search'), name: 'mcp__aaa__search', namespace: { name: 'mcp__aaa' } }], []);
  assert.match(browser.render(160).find((line) => line.startsWith(' ▌')), /zeta/);
  browser.handleInput('\r');
  assert.match(browser.render(160).join('\n'), /Resources \/ MCP \/ zeta/);
});

test('runtime updates preserve tool group expansion, search text and selected child', () => {
  const tools = [rawMcpTool('read'), rawMcpTool('search')];
  const browser = new ResourceBrowser(passthroughTheme,
    { categories: { ...emptyResources.categories, tools: buildToolResourceItems(tools, [], 'user'), mcp: [mcpServer] } },
    'tools', structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS), { onClose() {} }, process.cwd(), getKeybindings());
  browser.handleInput('mcp__docs__');
  browser.handleInput('\r'); // expand group
  browser.handleInput('\x1b[B');
  browser.handleInput('\x1b[B'); // search child
  browser.setRuntimeTools([rawMcpTool('a_first'), ...tools], ['mcp__docs__read']);
  const output = browser.render(180).join('\n');
  assert.match(output, /Search:.*mcp__docs__/);
  assert.match(output, /▾ mcp:docs/);
  assert.match(browser.render(180).find((line) => line.startsWith(' ▌')), /mcp__docs__search/);
  browser.handleInput('\r');
  browser.setRuntimeTools([rawMcpTool('a_first'), ...tools], tools.map((item) => item.name));
  assert.match(browser.render(180).join('\n'), /Resources \/ Tools \/ mcp__docs__search/);
});

test('live updates never prune pins or change builtin persistence scope', () => {
  const transient = { ...mcpServer, id: 'mcp:mcp__extra', name: 'extra', namespace: 'mcp__extra', source: 'runtime', configState: 'unknown', toggleMode: 'none' };
  let settingsWrites = 0;
  let toggled;
  const settings = { ...structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS), pinned: [transient.id] };
  const browser = new ResourceBrowser(passthroughTheme,
    { builtinToolScope: 'project', categories: { ...emptyResources.categories, mcp: [transient] } },
    'mcp', settings, { onClose() {}, onSettingsChange: () => settingsWrites++, onToggle: (item) => { toggled = item; } }, process.cwd(), getKeybindings());
  browser.setRuntimeTools([], []);
  browser.setRuntimeTools([{ ...rawMcpTool('search'), name: 'mcp__extra__search', namespace: { name: 'mcp__extra' } }], []);
  assert.match(browser.render(160).join('\n'), /\[pin\] extra/);
  assert.equal(settingsWrites, 0);
  browser.handleInput('\x1b[D'); // MCP -> Tools
  browser.setRuntimeTools([{ name: 'read', description: 'Read', exposure: 'direct', parameters: {},
    sourceInfo: { source: 'builtin', path: 'builtin:read', scope: 'temporary', origin: 'top-level' } }], []);
  browser.handleInput(' ');
  assert.equal(toggled.scope, 'project');
});

test('resource browser respects the custom TUI width contract', () => {
  const browser = new ResourceBrowser(
    passthroughTheme,
    emptyResources,
    'packages',
    structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS),
    { onClose() {} },
    process.cwd(),
    getKeybindings(),
  );

  for (const width of [20, 40, 80, 120]) {
    const lines = browser.render(width);
    assert(lines.length > 0);
    for (const line of lines) {
      assert(visibleWidth(line) <= width, `line exceeds width ${width}: ${line}`);
    }
  }
});
