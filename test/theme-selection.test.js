import test from 'node:test';
import assert from 'node:assert/strict';

import { getSelectedTheme } from '../src/settings/shared.ts';

const settingsFile = (theme) => ({
  path: '/tmp/settings.json',
  dir: '/tmp',
  settings: theme === undefined ? {} : { theme },
});

test('falls back to the current Pi UI theme when settings do not contain an explicit theme', () => {
  assert.equal(getSelectedTheme(settingsFile(undefined), settingsFile(undefined), 'dark'), 'dark');
});

test('current Pi UI theme takes precedence over saved settings', () => {
  assert.equal(getSelectedTheme(settingsFile('project-theme'), settingsFile('user-theme'), 'dark'), 'dark');
});

test('project theme setting is used when the current UI theme is unavailable', () => {
  assert.equal(getSelectedTheme(settingsFile('project-theme'), settingsFile('user-theme')), 'project-theme');
});

test('user theme setting is used when project and current themes are unavailable', () => {
  assert.equal(getSelectedTheme(settingsFile(undefined), settingsFile('user-theme')), 'user-theme');
});
