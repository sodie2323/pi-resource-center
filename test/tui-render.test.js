import test from 'node:test';
import assert from 'node:assert/strict';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { ResourceBrowser } from '../src/browser/browser.ts';
import { getDetailActions } from '../src/browser/actions.ts';
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
  },
};

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
