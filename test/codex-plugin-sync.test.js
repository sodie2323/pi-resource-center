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
  await writeJson(settingsPath, {
    skills: [
      skillsRoot.replace(/\\/g, '/'),
      `-${skillPath.replace(/\\/g, '/')}`,
      'C:/other/skills',
    ],
  });

  const { syncExternalSkillSourcesToPiSettings } = await import('../src/settings/center.ts');
  await syncExternalSkillSourcesToPiSettings([codexPluginsSource], [{ ...codexPluginsSource, enabled: false }], [
    'codex-plugins:disabled-superpowers:using-superpowers/SKILL.md',
  ]);

  const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(saved.skills, ['C:/other/skills']);
});
