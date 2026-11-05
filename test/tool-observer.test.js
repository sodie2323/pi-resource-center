import test from 'node:test';
import assert from 'node:assert/strict';
import { observeRuntimeTools } from '../src/resource/tool-observer.ts';

const tool = (name, extra = {}) => ({ name, description: name, exposure: 'codemode', namespace: { name: 'mcp__docs' },
  parameters: {}, sourceInfo: { source: 'builtin', path: 'builtin:mcp', origin: 'top-level', scope: 'user' }, ...extra });

function fixture() {
  const state = { tools: [], active: [], reads: 0, fail: false };
  const snapshots = [];
  const runtime = { getAllTools() { state.reads++; if (state.fail) throw new Error('Runtime replaced'); return state.tools; },
    getActiveTools: () => state.active, setActiveTools() { assert.fail('observation must never activate tools'); },
    getMcpServers() { assert.fail('observation must not discover configurations or connect servers'); } };
  const observer = observeRuntimeTools(runtime, (snapshot) => snapshots.push(snapshot));
  return { state, snapshots, observer };
}

test('runtime observer polls automatically each second and stops permanently after disposal', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { state, snapshots, observer } = fixture();
  t.after(() => observer.dispose());
  assert.equal(snapshots.length, 1);
  state.tools = [tool('mcp__docs__search')];
  t.mock.timers.tick(999);
  assert.equal(snapshots.length, 1);
  t.mock.timers.tick(1);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].tools[0].name, 'mcp__docs__search');
  t.mock.timers.tick(1000);
  assert.equal(snapshots.length, 2, 'unchanged inventories do not redraw');
  observer.dispose();
  const reads = state.reads;
  t.mock.timers.tick(5000);
  observer.refresh(true);
  assert.equal(state.reads, reads);
});

test('first live check completes even for an unchanged empty inventory and then stays quiet', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { state, snapshots, observer } = fixture();
  t.after(() => observer.dispose());
  assert.equal(snapshots[0].ready, false);
  state.fail = true;
  t.mock.timers.tick(1000);
  assert.equal(snapshots.length, 1, 'failed reads must not complete loading');
  state.fail = false;
  t.mock.timers.tick(1000);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].ready, true);
  assert.deepEqual(snapshots[1].tools, []);
  t.mock.timers.tick(3000);
  assert.equal(snapshots.length, 2, 'a settled empty inventory must not redraw or restart loading');
});

test('observer ignores nested validation changes and ordering but updates active, source, exposure and visible metadata', (t) => {
  const { state, snapshots, observer } = fixture();
  t.after(() => observer.dispose());
  state.tools = [tool('a'), tool('b', { parameters: { type: 'object', properties: { big: { type: 'string' } } } })];
  state.active = ['a', 'b'];
  observer.refresh();
  const count = snapshots.length;
  state.tools = [tool('b', { parameters: { type: 'object', properties: { big: { type: 'string', minLength: 20 } } } }), tool('a')];
  state.active = ['b', 'a'];
  observer.refresh();
  assert.equal(snapshots.length, count);
  for (const change of [
    () => { state.active = ['a']; },
    () => { state.tools = [tool('a', { exposure: 'hidden' })]; },
    () => { state.tools = [tool('a', { description: 'Updated' })]; },
    () => { state.tools = [tool('a', { namespace: { name: 'mcp__other' } })]; },
    () => { state.tools = [tool('a', { sourceInfo: { source: 'npm:other', path: '/other.ts', scope: 'project', origin: 'package' } })]; },
  ]) {
    const previous = snapshots.length;
    change();
    observer.refresh();
    assert.equal(snapshots.length, previous + 1);
  }
  observer.refresh(true);
  assert.equal(snapshots.length, count + 6, 'forced merge repairs inventory after overlapping full discovery');
});

test('observer updates when displayed parameter types, descriptions, defaults or required flags change', (t) => {
  const { state, snapshots, observer } = fixture();
  t.after(() => observer.dispose());
  for (const schema of [
    { type: 'object', properties: {} },
    { type: 'object', properties: { query: { type: 'string' } } },
    { type: 'object', properties: { query: { type: 'string', description: 'Search terms' } } },
    { type: 'object', properties: { query: { type: 'string', default: '' } } },
    { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    { type: 'object', properties: { query: { type: 'integer' } } },
  ]) {
    const previous = snapshots.length;
    state.tools = [tool('a', { parameters: schema })];
    observer.refresh();
    assert.equal(snapshots.length, previous + 1);
  }
});

test('transient runtime read failures keep the last snapshot and recover on the next check', (t) => {
  const { state, snapshots, observer } = fixture();
  t.after(() => observer.dispose());
  state.fail = true;
  observer.refresh();
  assert.equal(snapshots.length, 1);
  state.tools = [tool('mcp__docs__read')];
  state.fail = false;
  observer.refresh();
  assert.equal(snapshots.length, 2);
});
