import test from 'node:test';
import assert from 'node:assert/strict';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { ResourceBrowser } from '../src/browser/browser.ts';
import { getDetailActions } from '../src/browser/actions.ts';
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
