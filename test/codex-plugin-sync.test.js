import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'pi-resource-center-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createCodexPluginFixture(pluginName) {
  const pluginRoot = join(home, '.codex', 'plugins', 'cache', 'openai-curated', pluginName, 'acdd3141');
  const skillsRoot = join(pluginRoot, 'skills');
  const skillPath = join(skillsRoot, 'using-superpowers', 'SKILL.md');
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
  await mkdir(join(skillsRoot, 'using-superpowers'), { recursive: true });
  await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: pluginName }), 'utf8');
  await writeFile(skillPath, '---\nname: using-superpowers\n---\n', 'utf8');

  return { skillsRoot, skillPath };
}

const codexPluginsSource = {
  id: 'codex-plugins',
  label: 'Codex Plugins',
  path: '~/.codex/plugins',
  enabled: true,
  integration: 'codex-plugin-cache',
};

test('sync writes disabled Codex plugin skills to Pi settings as force-excludes', async () => {
  const { skillsRoot, skillPath } = await createCodexPluginFixture('superpowers');
  const settingsPath = join(home, '.pi', 'agent', 'settings.json');
  await writeJson(settingsPath, { skills: [] });

  const { syncExternalSkillSourcesToPiSettings } = await import('../src/settings/center.ts');
  await syncExternalSkillSourcesToPiSettings([], [codexPluginsSource], [
    'codex-plugins:superpowers:using-superpowers/SKILL.md',
  ]);

  const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert(saved.skills.includes(skillsRoot.replace(/\\/g, '/')));
  assert(saved.skills.includes(`-${skillPath.replace(/\\/g, '/')}`));
});

test('sync removes Codex plugin skill roots when the integration is disabled', async () => {
  const { skillsRoot, skillPath } = await createCodexPluginFixture('disabled-superpowers');
  const settingsPath = join(home, '.pi', 'agent', 'settings.json');
  const managedRoot = skillsRoot.replace(/\\/g, '/');
  const managedDisable = `-${skillPath.replace(/\\/g, '/')}`;
  await writeJson(settingsPath, {
    skills: [
      managedRoot,
      managedDisable,
      'C:/other/skills',
    ],
  });
  await writeJson(join(home, '.pi', 'agent', 'pi-resource-center-settings.json'), {
    externalSkillSources: [codexPluginsSource],
    externalSkillSyncEntries: [managedRoot, managedDisable],
  });

  const { syncExternalSkillSourcesToPiSettings } = await import('../src/settings/center.ts');
  await syncExternalSkillSourcesToPiSettings([codexPluginsSource], [{ ...codexPluginsSource, enabled: false }], [
    'codex-plugins:disabled-superpowers:using-superpowers/SKILL.md',
  ]);

  const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(saved.skills, ['C:/other/skills']);
});

test('legacy migration removes only exact roots and preserves user descendants', async () => {
  const sourceRoot = join(home, '.config', 'opencode', 'skills').replace(/\\/g, '/');
  const userDescendant = join(home, '.config', 'opencode', 'skills', 'personal', 'SKILL.md').replace(/\\/g, '/');
  const source = {
    id: 'opencode',
    label: 'OpenCode',
    path: '~/.config/opencode/skills',
    enabled: true,
    integration: 'skill-root',
  };
  const settingsPath = join(home, '.pi', 'agent', 'settings.json');
  await writeJson(settingsPath, { skills: [sourceRoot, userDescendant] });
  await writeJson(join(home, '.pi', 'agent', 'pi-resource-center-settings.json'), {
    externalSkillSources: [source],
  });

  const { syncExternalSkillSourcesToPiSettings } = await import('../src/settings/center.ts');
  await syncExternalSkillSourcesToPiSettings([source], [{ ...source, enabled: false }]);

  const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(saved.skills, [userDescendant]);
});

test('sync removes only exact managed entries and preserves user descendants', async () => {
  const sourceRoot = join(home, '.claude', 'skills').replace(/\\/g, '/');
  const userDescendant = join(home, '.claude', 'skills', 'personal', 'SKILL.md').replace(/\\/g, '/');
  const source = {
    id: 'claude',
    label: 'Claude',
    path: '~/.claude/skills',
    enabled: true,
    integration: 'skill-root',
  };
  const settingsPath = join(home, '.pi', 'agent', 'settings.json');
  await writeJson(settingsPath, { skills: [sourceRoot, userDescendant] });
  await writeJson(join(home, '.pi', 'agent', 'pi-resource-center-settings.json'), {
    externalSkillSources: [source],
    externalSkillSyncEntries: [sourceRoot],
  });

  const { syncExternalSkillSourcesToPiSettings } = await import('../src/settings/center.ts');
  await syncExternalSkillSourcesToPiSettings([source], [{ ...source, enabled: false }]);

  const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(saved.skills, [userDescendant]);
});
