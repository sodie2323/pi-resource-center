import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'pi-resource-center-compat-'));
const agentDir = join(home, 'custom-agent');
const cwd = join(home, 'project');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(cwd, { recursive: true });

const shared = await import('../src/settings/shared.ts');
const { getAgentDir } = await import('@earendil-works/pi-coding-agent');

test('uses Pi configured agent directory', () => {
  assert.equal(resolve(shared.USER_AGENT_DIR), resolve(getAgentDir()));
});

test('recognizes autoload:false package deltas', () => {
  assert.equal(shared.isPackageSourceEnabled({ source: 'npm:empty', autoload: false }), false);
  assert.equal(shared.isPackageSourceEnabled({ source: 'npm:partial', autoload: false, skills: ['+skills/demo/SKILL.md'] }), true);
  assert.equal(shared.isPackageSourceEnabled({ source: 'npm:disabled', extensions: [], skills: [], prompts: [], themes: [] }), false);
});

test('refuses project settings writes when project is not trusted', async () => {
  const { addPathResourceToSettings } = await import('../src/settings/mutations.ts');
  await assert.rejects(
    addPathResourceToSettings(cwd, 'skills', join(cwd, 'skill'), 'project', false),
    /Project is not trusted/,
  );
});

test('manual skill toggles preserve the discovery root and use exact overrides', async () => {
  const skillDir = join(home, 'manual-skill');
  const skillPath = join(skillDir, 'SKILL.md');
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, '---\nname: manual-skill\ndescription: manual fixture\n---\n', 'utf8');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ skills: ['~/manual-skill'] }), 'utf8');

  const { toggleResourceInSettings } = await import('../src/settings/mutations.ts');
  const item = {
    category: 'skills',
    id: 'manual-skill',
    name: 'manual-skill',
    scope: 'user',
    path: skillPath,
    source: 'manual',
    description: '',
    enabled: false,
  };
  await toggleResourceInSettings(cwd, item, false);
  let saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert(saved.skills.includes('~/manual-skill'));
  assert(saved.skills.includes(`-${skillPath.replace(/\\/g, '/')}`));

  item.enabled = true;
  await toggleResourceInSettings(cwd, item, false);
  saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert(saved.skills.includes('~/manual-skill'));
  assert(saved.skills.includes(`+${skillPath.replace(/\\/g, '/')}`));
  assert.equal(saved.skills.some((entry) => entry.startsWith('-')), false);
});

test('package add preserves existing object filters and autoload state', async () => {
  const packageDir = join(home, 'local-package');
  await mkdir(join(packageDir, 'skills', 'demo'), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: 'local-package',
    keywords: ['pi-package'],
    pi: { skills: ['./skills'] },
  }), 'utf8');
  await writeFile(join(packageDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n', 'utf8');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    packages: [{ source: packageDir, autoload: false, skills: ['+skills/demo/SKILL.md'] }],
  }), 'utf8');

  const { addResourceFromInput } = await import('../src/resource/commands.ts');
  await addResourceFromInput(cwd, packageDir, 'user', undefined, false);

  const secondPackageDir = join(home, 'second-local-package');
  await mkdir(secondPackageDir, { recursive: true });
  await writeFile(join(secondPackageDir, 'package.json'), JSON.stringify({
    name: 'second-local-package',
    keywords: ['pi-package'],
    pi: { extensions: [] },
  }), 'utf8');
  await addResourceFromInput(cwd, secondPackageDir, 'user', undefined, false);

  const saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(saved.packages.length, 2);
  assert.equal(saved.packages[0].autoload, false);
  assert.deepEqual(saved.packages[0].skills, ['+skills/demo/SKILL.md']);
  assert.equal(typeof saved.packages[1], 'string');
});

test('package resource toggles preserve autoload and unrelated filters', async () => {
  const source = 'npm:filtered-package';
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    packages: [{
      source,
      autoload: false,
      skills: ['!skills/legacy/**', '+skills/demo/SKILL.md'],
      extensions: ['extensions/*.ts'],
    }],
  }), 'utf8');

  const { toggleResourceInSettings } = await import('../src/settings/mutations.ts');
  const item = {
    category: 'skills',
    id: 'filtered-package-demo',
    name: 'demo',
    scope: 'user',
    path: join(home, 'installed', 'skills', 'demo', 'SKILL.md'),
    source,
    description: '',
    enabled: false,
    packageSource: source,
    packageRelativePath: 'skills/demo/SKILL.md',
  };
  await toggleResourceInSettings(cwd, item, false);
  let saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(saved.packages[0].autoload, false);
  assert.deepEqual(saved.packages[0].extensions, ['extensions/*.ts']);
  assert.deepEqual(saved.packages[0].skills, ['!skills/legacy/**', '-skills/demo/SKILL.md']);

  item.enabled = true;
  await toggleResourceInSettings(cwd, item, false);
  saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.packages[0].skills, ['!skills/legacy/**', '+skills/demo/SKILL.md']);
});

test('whole-package toggle intentionally resets fine-grained filters', async () => {
  const source = 'npm:whole-package';
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    packages: [{ source, autoload: false, skills: ['+skills/demo/SKILL.md'] }],
  }), 'utf8');

  const { toggleResourceInSettings } = await import('../src/settings/mutations.ts');
  const item = {
    category: 'packages',
    id: 'whole-package',
    name: source,
    scope: 'user',
    source,
    description: '',
    enabled: false,
  };
  await toggleResourceInSettings(cwd, item, false);
  let saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.packages[0], {
    source,
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });

  item.enabled = true;
  await toggleResourceInSettings(cwd, item, false);
  saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(saved.packages[0], source);
});

test('resource center refuses to disable its own package from inside itself', async () => {
  const source = 'D:/Dev/pi-resource-center';
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [source] }), 'utf8');
  const { toggleResourceInSettings } = await import('../src/settings/mutations.ts');
  await assert.rejects(toggleResourceInSettings(cwd, {
    category: 'packages',
    id: 'self-package',
    name: source,
    scope: 'user',
    source,
    description: '',
    enabled: false,
  }, false), /cannot disable its own package/);
  const saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.packages, [source]);
});

test('does not discover project resources before project trust', async () => {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({}), 'utf8');
  const skillDir = join(cwd, shared.PROJECT_AGENT_DIR, 'skills', 'project-secret');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: project-secret\ndescription: trust fixture\n---\n', 'utf8');

  const { discoverResources } = await import('../src/resource/discovery.ts');
  const untrusted = await discoverResources(cwd, 'dark', {
    projectTrusted: false,
    syncExternalSkills: false,
  });
  assert.equal(untrusted.categories.skills.some((item) => item.name === 'project-secret'), false);

  const trusted = await discoverResources(cwd, 'dark', {
    projectTrusted: true,
    syncExternalSkills: false,
  });
  assert.equal(trusted.categories.skills.some((item) => item.name === 'project-secret'), true);
});

test('uses theme JSON name and the live Pi theme', async () => {
  const themeDir = join(agentDir, 'themes');
  await mkdir(themeDir, { recursive: true });
  await writeFile(join(themeDir, 'file-stem.json'), JSON.stringify({ name: 'content-theme', colors: {} }), 'utf8');
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ themes: ['themes/file-stem.json'] }), 'utf8');

  const { discoverResources } = await import('../src/resource/discovery.ts');
  const resources = await discoverResources(cwd, 'content-theme', {
    projectTrusted: false,
    syncExternalSkills: false,
  });
  const theme = resources.categories.themes.find((item) => item.name === 'content-theme');
  assert(theme);
  assert.equal(theme.enabled, true);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  await writeFile(join(themeDir, 'file-stem.json'), JSON.stringify({ name: 'updated-theme', colors: {} }), 'utf8');
  const refreshed = await discoverResources(cwd, 'updated-theme', {
    projectTrusted: false,
    syncExternalSkills: false,
  });
  assert.equal(refreshed.categories.themes.some((item) => item.name === 'content-theme'), false);
  assert.equal(refreshed.categories.themes.find((item) => item.name === 'updated-theme')?.enabled, true);
});
