import test from 'node:test';
import assert from 'node:assert/strict';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { ResourceBrowser } from '../src/browser/browser.ts';
import { renderPromptPreview, renderToolParameters } from '../src/browser/detail-content.ts';
import { summarizeToolParameters } from '../src/resource/tool-parameters.ts';
import { buildToolResourceItems } from '../src/resource/tool-runtime.ts';
import { DEFAULT_RESOURCE_CENTER_SETTINGS } from '../src/settings/shared.ts';

const theme = new Proxy({ fg: (_color, text) => text, bg: (_color, text) => text }, {
  get: (target, key) => target[key] ?? ((text) => text),
});
const categories = { packages: [], skills: [], extensions: [], prompts: [], themes: [], tools: [], mcp: [] };
const rawTool = (parameters) => ({ name: 'source_check', description: 'Gather cited passages about a claim.', exposure: 'direct', parameters,
  sourceInfo: { source: 'auto', path: '/extensions/web.ts', scope: 'user', origin: 'top-level' } });
const browserFor = (item, callbacks = {}) => new ResourceBrowser(theme, { categories: { ...categories, [item.category]: [item] } },
  item.category, structuredClone(DEFAULT_RESOURCE_CENTER_SETTINGS), { onClose() {}, ...callbacks }, process.cwd(), getKeybindings());

const schema = { type: 'object', required: ['claim'], properties: {
  claim: { type: 'string', description: 'Assertion to check' },
  queries: { type: 'array', items: { type: 'string' }, description: 'Search queries' },
  numResults: { type: 'integer', default: 5, description: 'Number of results' },
  fetchContent: { type: 'boolean', default: false, description: 'Fetch source passages' },
} };

test('parameter summaries retain only top-level display information, including scalar defaults and required flags', () => {
  const summaries = summarizeToolParameters(schema);
  assert.deepEqual(summaries[0], { name: 'claim', type: 'string', required: true, description: 'Assertion to check', defaultValue: undefined });
  assert.equal(summaries[1].type, 'string[]');
  assert.equal(summaries[2].defaultValue, '5');
  assert.equal(summaries[3].defaultValue, 'false');
  assert.equal('properties' in summaries[0], false);
  assert.equal(summarizeToolParameters({}), undefined, 'missing metadata is not confirmed zero parameters');
  assert.deepEqual(summarizeToolParameters({ type: 'object', properties: {} }), []);
});

test('parameter summaries handle references, unions, nullable values, enum and recursive objects without dumping nested schemas', () => {
  const parameters = summarizeToolParameters({ type: 'object', $defs: {
    Query: { type: 'string', description: ' Search\n terms ' },
    Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } },
    Loop: { $ref: '#/$defs/Loop' },
  }, properties: {
    query: { $ref: '#/$defs/Query' },
    mode: { enum: ['fast', 'deep'], default: 'fast' },
    mixed: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
    nullable: { type: ['integer', 'null'] },
    node: { $ref: '#/$defs/Node', default: { huge: 'must not display' } },
    loop: { $ref: '#/$defs/Loop' },
    list: { type: 'array', items: { $ref: '#/$defs/Query' } },
    empty: { type: 'string', default: '' },
  } });
  assert.equal(parameters[0].description, 'Search terms');
  assert.equal(parameters[1].type, 'enum');
  assert.equal(parameters[1].defaultValue, '"fast"');
  assert.equal(parameters[2].type, 'string | null');
  assert.equal(parameters[2].defaultValue, 'null');
  assert.equal(parameters[3].type, 'integer | null');
  assert.equal(parameters[4].type, 'object');
  assert.equal(parameters[4].defaultValue, undefined);
  assert.equal(parameters[5].type, 'unknown');
  assert.equal(parameters[6].type, 'string[]');
  assert.equal(parameters[7].defaultValue, '""');
  assert.equal(JSON.stringify(parameters).includes('must not display'), false);
});

test('tool argument details include names, explanations, types, defaults and required markers', () => {
  const output = renderToolParameters(theme, summarizeToolParameters(schema), 100).join('\n');
  for (const value of ['claim*', '* required', 'Assertion to check', 'queries', 'Search queries', 'string[]', 'integer', 'default 5', 'default false']) {
    assert(output.includes(value), `missing argument information: ${value}`);
  }
  assert.match(renderToolParameters(theme, [], 100).join('\n'), /None/);
  assert.deepEqual(renderToolParameters(theme, undefined, 100), []);
});

test('narrow tool details keep names and types together and put descriptions below, without overflowing', () => {
  const item = buildToolResourceItems([rawTool(schema)], ['source_check'], 'user')[0];
  const browser = browserFor(item);
  browser.handleInput('\r');
  for (const width of [1, 2, 12, 32, 48, 53, 54, 80, 120]) {
    const lines = browser.render(width, 60);
    for (const line of lines) assert(visibleWidth(line) <= width, `width ${width}: ${line}`);
  }
  const lines = browser.render(48, 60);
  const claim = lines.findIndex((line) => /claim\* +string/.test(line));
  assert(claim > 0);
  assert.match(lines[claim + 1], /Assertion to check/);
  assert.equal(lines.some((line) => line.includes('Source:')), false);
});

test('j/k scroll every parameter without changing actions or taking over PageUp/PageDown', () => {
  const properties = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`arg${String(i).padStart(2, '0')}`, { type: 'string', description: `Argument ${i}` }]));
  const raw = rawTool({ type: 'object', properties });
  let toggles = 0;
  const browser = browserFor(buildToolResourceItems([raw], ['source_check'], 'user')[0], { onToggle: () => toggles++ });
  browser.handleInput('\r');
  const tall = browser.render(90, 60).join('\n');
  assert.deepEqual([...tall.matchAll(/arg\d{2}/g)].map((match) => match[0]), ['arg00', 'arg01', 'arg02', 'arg03'], 'even tall windows show at most four arguments initially');
  const initial = browser.render(90, 24).join('\n');
  browser.handleInput('\x1b[6~');
  browser.handleInput('\x1b[5~');
  assert.equal(browser.render(90, 24).join('\n'), initial, 'PageUp/PageDown must not scroll details');
  browser.handleInput('J');
  assert.notEqual(browser.render(90, 24).join('\n'), initial);
  browser.handleInput('K');
  assert.equal(browser.render(90, 24).join('\n'), initial);
  browser.handleInput('j');
  browser.render(90, 24);
  browser.handleInput('k');
  assert.equal(browser.render(90, 24).join('\n'), initial);
  browser.handleInput('\x1b[B');
  assert.match(browser.render(90, 24).join('\n'), /› Back/);
  browser.handleInput('j');
  assert.match(browser.render(90, 24).join('\n'), /› Back/, 'scrolling must not move action selection');
  browser.handleInput('\x1b[A');
  browser.handleInput('k');
  const visited = new Set();
  let previous;
  for (let i = 0; i < 50; i++) {
    const lines = browser.render(90, 24);
    assert(lines.length <= 24);
    assert(lines.slice(-7).some((line) => line.trim() === 'Actions'));
    assert(lines.slice(-7).some((line) => line.includes('Disable')));
    const output = lines.join('\n');
    const argumentsShown = [...output.matchAll(/arg\d{2}/g)].map((match) => match[0]);
    assert(argumentsShown.length <= 4, 'scrolling keeps the four-argument display limit');
    for (const name of argumentsShown) visited.add(name);
    if (output === previous) break;
    previous = output;
    browser.handleInput('j');
  }
  assert.equal(visited.size, 30, 'no argument may be silently inaccessible');
  assert.match(browser.render(90, 24).join('\n'), /arg29/);
  browser.setRuntimeTools([{ ...raw, parameters: { type: 'object', properties: { last: { type: 'boolean', description: 'New schema' } } } }], ['source_check']);
  assert.match(browser.render(90, 24).join('\n'), /last +New schema · boolean/);
  browser.handleInput('\r');
  assert.equal(toggles, 1, 'scrolling must not change the selected action');
  browser.handleInput('\x1b');
  browser.handleInput('\r');
  assert.match(browser.render(90, 24).join('\n'), /Description/);
});

test('o expands only long descriptions in details, without adding actions or taking over list search', () => {
  const raw = { ...rawTool(schema), description: Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}.`).join('\n') };
  const browser = browserFor(buildToolResourceItems([raw], ['source_check'], 'user')[0]);
  browser.handleInput('\r');
  const collapsed = browser.render(90, 60).join('\n');
  assert.match(collapsed, /o expand/);
  assert(collapsed.includes('Paragraph 4.'));
  assert.equal(collapsed.includes('Paragraph 5.'), false);
  browser.handleInput('\x1b[B');
  browser.handleInput('o');
  const expanded = browser.render(90, 60).join('\n');
  assert.match(expanded, /o collapse/);
  assert(expanded.includes('Paragraph 8.'));
  assert.match(expanded, /› Back/);
  assert.equal(expanded.includes('Expand Description'), false, 'expansion is not an action-menu item');
  browser.handleInput('o');
  assert.equal(browser.render(90, 60).join('\n').includes('Paragraph 5.'), false);
  browser.setRuntimeTools([rawTool(schema)], ['source_check']);
  const short = browser.render(90, 60).join('\n');
  browser.handleInput('o');
  assert.equal(browser.render(90, 60).join('\n'), short, 'short descriptions ignore o');
  browser.handleInput('\x1b');
  browser.handleInput('o');
  assert.match(browser.render(90).join('\n'), /Search:.*o/);
});

test('body overflow and parameter overflow share one scroll hint, with only parameter counts retained', () => {
  const raw = { ...rawTool({ type: 'object', properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`arg${i}`, { type: 'string' }])) }),
    description: Array.from({ length: 40 }, (_, i) => `Description line ${i + 1}`).join('\n') };
  const browser = browserFor(buildToolResourceItems([raw], [], 'user')[0]);
  browser.handleInput('\r');
  const collapsed = browser.render(80, 60).join('\n');
  assert.equal((collapsed.match(/j↓ k↑/g) ?? []).length, 1);
  assert.match(collapsed, /Parameters.*1–4\/8/);
  browser.handleInput('o');
  let reachedParameters = false;
  for (let i = 0; i < 60; i++) {
    const text = browser.render(80, 24).join('\n');
    assert.equal((text.match(/j↓ k↑/g) ?? []).length, 1);
    if (/Parameters.*1–4\/8/.test(text)) {
      assert.equal((text.match(/\d+–\d+\/\d+/g) ?? []).length, 1, 'no second body-line counter');
      reachedParameters = true;
      break;
    }
    browser.handleInput('j');
  }
  assert(reachedParameters, 'expanded text and parameters remain reachable');
});

test('narrow details keep the resource name, complete action labels and an escape hint', () => {
  const tool = browserFor(buildToolResourceItems([rawTool(schema)], [], 'user')[0]);
  tool.handleInput('\r');
  const lines = tool.render(22, 60);
  assert(lines[1].trimEnd().endsWith('source_check'));
  assert(lines.some((line) => line.includes('Esc back')));
  assert.equal(lines.some((line) => line.includes('Disable for')), false, 'omit an unusable hint before clipping the action');
  const pkg = browserFor({ category: 'packages', id: 'pkg:example', name: 'example', source: 'npm:example', scope: 'user', description: 'Example package', enabled: true });
  pkg.handleInput('\r');
  const actions = pkg.render(22, 60);
  assert(actions.join('').replace(/\s/g, '').includes('BrowsePackageContents'));
  for (const line of [...lines, ...actions]) assert(visibleWidth(line) <= 22);
});

test('prompt preview counts wrapped display lines, not source lines, and marks both viewport and storage truncation', () => {
  const text = 'one two three four five six seven eight nine ten '.repeat(8);
  const lines = renderPromptPreview(theme, text, 30);
  assert.equal(lines.length, 8, 'heading + six content lines + ellipsis');
  assert.equal(lines.at(-1).trim(), '…');
  for (const line of lines) assert(visibleWidth(line) <= 30);
  assert.equal(renderPromptPreview(theme, 'one\ntwo\nthree\nfour\nfive\nsix', 80).length, 7);
  assert.equal(renderPromptPreview(theme, 'short', 80, true).at(-1).trim(), '…');
});

test('prompt details show body and argument hint without duplicated description or expanded argument values', () => {
  const item = { category: 'prompts', id: 'prompt:review', name: 'review', scope: 'user', source: 'auto', path: '/review.md', enabled: true,
    description: 'Review this change.', argumentHint: '<file>', promptPreview: 'Review this change.\n\nInspect $1 and preserve $@.\nDo not execute commands.' };
  const browser = browserFor(item);
  browser.handleInput('\r');
  const output = browser.render(100, 60).join('\n');
  assert.match(output, /Argument Hint: <file>/);
  assert.match(output, /Preview/);
  assert.equal(output.includes('Description'), false);
  assert.equal(output.split('Review this change.').length - 1, 1);
  assert.match(output, /Inspect \$1 and preserve \$@/);
  assert(output.indexOf('Preview') < output.indexOf('Actions'));
});
