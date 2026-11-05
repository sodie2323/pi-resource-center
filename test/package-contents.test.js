import test from 'node:test';
import assert from 'node:assert/strict';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { ResourceBrowser } from '../src/browser/browser.ts';
import { DEFAULT_RESOURCE_CENTER_SETTINGS } from '../src/settings/shared.ts';

const theme = new Proxy({ fg: (_color, text) => text, bg: (_color, text) => text }, { get: (target, key) => target[key] ?? ((text) => text) });
const pkg = { category: 'packages', id: 'packages:user:npm:example', name: 'example', scope: 'user', source: 'npm:example', description: 'Example package', enabled: true };
const leaf = (category, name, extra = {}) => ({ category, name, id: `${category}:user:${name}`, scope: 'user', source: pkg.source,
  packageSource: pkg.source, packageRelativePath: `${category}/${name}`, path: `/package/${category}/${name}`, enabled: true, exposed: false, description: 'Example resource', ...extra });
function fixture(items, callbacks = {}) {
  const categories = { packages: [pkg], skills: [], extensions: [], prompts: [], themes: [], tools: [], mcp: [] };
  for (const item of items) categories[item.category].push(item);
  const resources = { categories };
  const browser = new ResourceBrowser(theme, resources, 'packages', { ...structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS), sortMode: 'name', packagePreviewLimit: 3 },
    { onClose() {}, ...callbacks }, process.cwd(), getKeybindings());
  browser.handleInput('\r');
  browser.handleInput('\r');
  return { browser, resources };
}
const output = (browser) => browser.render(110).join('\n');
const selectedRow = (browser) => browser.render(110).find((line) => line.startsWith(' ▌'));

test('package contents flatten all four resource types and distinguish same-name items without leaking other packages or scopes', () => {
  const { browser } = fixture([
    leaf('extensions', 'alpha.ts'), leaf('themes', 'forest'), leaf('prompts', 'review.md'),
    leaf('skills', 'review', { id: 'skill:a', packageRelativePath: 'skills/a/SKILL.md' }),
    leaf('skills', 'review', { id: 'skill:b', packageRelativePath: 'skills/b/SKILL.md' }),
    leaf('skills', 'other-package', { packageSource: 'npm:other' }),
    leaf('skills', 'project-only', { scope: 'project' }),
  ]);
  const text = output(browser);
  for (const name of ['alpha.ts', 'forest', 'review.md', 'skills/a/SKILL.md', 'skills/b/SKILL.md']) assert(text.includes(name));
  for (const label of ['Extension', 'Skill', 'Prompt', 'Theme']) assert(text.includes(label));
  assert.equal(text.includes('other-package'), false);
  assert.equal(text.includes('project-only'), false);
  assert.equal(text.includes('[pkg]'), false);
  assert.equal(text.includes('more, press Enter'), false);
  assert(text.indexOf('forest') < text.indexOf('skills/a/SKILL.md'), 'sort across types, not within category blocks');
  for (const width of [20, 40, 80]) {
    for (const line of browser.render(width)) assert(visibleWidth(line) <= width);
    assert(browser.render(width).some((line) => line.trimEnd().endsWith('Extension')), 'keep the type visible at narrow widths');
  }
});

test('type search, leaf toggle and detail return work in the aggregate list without clearing the search', () => {
  const prompt = leaf('prompts', 'review.md');
  let toggled;
  const { browser } = fixture([leaf('skills', 'review'), prompt, leaf('themes', 'forest')], { onToggle: (item) => { toggled = item; } });
  browser.handleInput('prompt');
  assert.match(selectedRow(browser), /review\.md/);
  assert.equal(output(browser).includes('forest'), false);
  browser.handleInput(' ');
  assert.equal(toggled.id, prompt.id);
  assert.equal(toggled.enabled, false);
  browser.handleInput('\r');
  assert.match(output(browser), /Packages \/ npm:example \/ Prompts \/ review\.md/);
  browser.handleInput('\x1b');
  assert.match(output(browser), /Contents/);
  assert.match(output(browser), /Search:.*prompt/);
  assert.match(selectedRow(browser), /review\.md/);
  browser.handleInput('\x1b');
  assert.match(output(browser), /Browse Package Contents/);
});

test('long package lists retain identity through navigation, pinning, sorting and runtime refresh', () => {
  const items = Array.from({ length: 18 }, (_, index) => leaf('skills', `item${String(index).padStart(2, '0')}`, { enabled: index % 2 === 0 }));
  let inspected;
  const { browser, resources } = fixture(items, { onInspect: (item) => { inspected = item; } });
  browser.handleInput('skill');
  for (let index = 0; index < 12; index++) browser.handleInput('\x1b[B');
  browser.handleInput('\r');
  const targetId = inspected.id;
  browser.handleInput('\x1b');
  browser.handleInput('P');
  browser.handleInput('\t');
  browser.setResources({ categories: { ...resources.categories, skills: [leaf('skills', 'aaa-new'), ...items.map((item) => ({ ...item }))] } });
  assert.match(output(browser), /Search:.*skill/);
  assert.match(selectedRow(browser), /item12/);
  browser.handleInput('\r');
  assert.equal(inspected.id, targetId, 'selection follows identity rather than a stale row index');
  browser.handleInput('\x1b');
  browser.handleInput('\x1b[6~');
  browser.handleInput('\r');
  assert.notEqual(inspected.id, targetId, 'normal list paging reaches resources beyond the old preview limit');
});
