import test from 'node:test';
import assert from 'node:assert/strict';
import { setExactOverride } from '../src/resource/config-overrides.ts';

test('enable replaces an exact disable and preserves unrelated patterns', () => {
  assert.deepEqual(
    setExactOverride(
      ['!skills/legacy/**', '-skills/demo/SKILL.md', '-skills/other/SKILL.md'],
      'skills/demo/SKILL.md',
      true,
    ),
    ['!skills/legacy/**', '-skills/other/SKILL.md', '+skills/demo/SKILL.md'],
  );
});

test('disable replaces exact plain/include/exclude entries and is idempotent', () => {
  const first = setExactOverride(
    ['skills/demo/SKILL.md', '+skills/demo/SKILL.md', '!skills/demo/SKILL.md', '!skills/legacy/**'],
    'skills/demo/SKILL.md',
    false,
  );
  assert.deepEqual(first, ['!skills/legacy/**', '-skills/demo/SKILL.md']);
  assert.deepEqual(setExactOverride(first, 'skills/demo/SKILL.md', false), first);
});

test('normalizes slash direction for exact matching', () => {
  assert.deepEqual(
    setExactOverride(['-skills\\demo\\SKILL.md'], 'skills/demo/SKILL.md', true),
    ['+skills/demo/SKILL.md'],
  );
});

test('manual mode preserves plain discovery entries', () => {
  assert.deepEqual(
    setExactOverride(
      ['/external/my-skill', '-/external/my-skill/SKILL.md', '!**/draft/**'],
      '/external/my-skill/SKILL.md',
      true,
      { preserveMatchingPlainEntries: true },
    ),
    ['/external/my-skill', '!**/draft/**', '+/external/my-skill/SKILL.md'],
  );
});
