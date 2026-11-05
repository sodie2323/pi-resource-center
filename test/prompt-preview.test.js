import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'pi-resource-center-preview-'));
const agentDir = join(home, 'agent');
const cwd = join(home, 'project');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, 'prompts'), { recursive: true });
await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
await writeFile(join(agentDir, 'settings.json'), '{}');
after(() => rm(home, { recursive: true, force: true }));
const { discoverResources } = await import('../src/resource/discovery.ts');
const discover = (projectTrusted = false) => discoverResources(cwd, undefined, { projectTrusted, syncExternalSkills: false });

async function save(name, content, project = false) {
  const path = join(project ? join(cwd, '.pi') : agentDir, 'prompts', `${name}.md`);
  await writeFile(path, content, 'utf8');
  return path;
}

test('prompt discovery retains a body preview separate from BOM/CRLF frontmatter and argument hints', async () => {
  await save('review', '\uFEFF---\r\ndescription: Review a change\r\nargument-hint: <file>\r\n---\r\n\r\n# Review\r\n\r\nInspect $1 without expanding $@.\r\n');
  const index = await discover();
  const item = index.categories.prompts.find((item) => item.name === 'review.md');
  assert(item);
  assert.equal(item.description, 'Review a change');
  assert.equal(item.argumentHint, '<file>');
  assert.equal(item.promptPreview, '# Review\n\nInspect $1 without expanding $@.');
  assert.equal(item.promptPreviewTruncated, false);
  assert.equal(item.promptPreview.includes('argument-hint'), false);
});

test('prompts without frontmatter use their body preview instead of a synthetic path description', async () => {
  await save('plain', '\n\nExplain $1.\n\nKeep {{input}} unchanged.\n');
  const index = await discover();
  const item = index.categories.prompts.find((item) => item.name === 'plain.md');
  assert.equal(item.description, '');
  assert.equal(item.promptPreview, 'Explain $1.\n\nKeep {{input}} unchanged.');
});

test('cached prompt bodies are bounded and invalidate after the file changes', async () => {
  const path = await save('large', 'A very long prompt.\n' + 'paragraph '.repeat(5000));
  const first = (await discover()).categories.prompts.find((item) => item.name === 'large.md');
  assert.equal(first.promptPreview.length, 8192);
  assert.equal(first.promptPreviewTruncated, true);
  await writeFile(path, 'New content.\n');
  const future = new Date(Date.now() + 2000);
  await utimes(path, future, future);
  const second = (await discover()).categories.prompts.find((item) => item.name === 'large.md');
  assert.equal(second.promptPreview, 'New content.');
  assert.equal(second.promptPreviewTruncated, false);
});

test('project prompt previews are not discovered before project trust', async () => {
  await save('trusted-only', 'Project private instructions.', true);
  assert.equal((await discover(false)).categories.prompts.some((item) => item.name === 'trusted-only.md'), false);
  const item = (await discover(true)).categories.prompts.find((item) => item.name === 'trusted-only.md');
  assert.equal(item.promptPreview, 'Project private instructions.');
  assert.equal(item.scope, 'project');
});
