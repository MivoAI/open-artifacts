import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { buildCli, repositoryRoot, stopSession } from './helpers/cli.mjs';
import { createPackedCliFixture } from './helpers/packed-cli.mjs';

const artifactRoot = resolve(repositoryRoot, 'packages/artifact-video-editor');
const input = JSON.parse(await readFile(resolve(artifactRoot, 'example.json'), 'utf8'));

test.before(buildCli);

test('Video Editor closes UI → Tool → Data → UI and Annotation loops', async (t) => {
  const fixture = await createPackedCliFixture();
  let browser;
  let session;
  let stopped = false;

  t.after(async () => {
    await browser?.close();
    if (session && !stopped) {
      const result = await fixture
        .runOa(['session', 'stop', session.sessionId, '--json'])
        .catch(() => undefined);
      if (!result || result.status !== 0) await stopSession(fixture.home, session.sessionId);
    }
    await fixture.dispose();
  });

  const started = await fixture.runOa(
    ['run', artifactRoot, '--data', JSON.stringify(input), '--json', '--no-open'],
    { timeout: 60_000 },
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);
  session = JSON.parse(started.stdout);
  assert.equal(session.artifact.format, 'react-runtime/v1');
  assert.match(session.bundlePath, /\.openartifact$/);

  const toolsResult = await fixture.runOa([
    'tool',
    'list',
    '--instance',
    session.instanceId,
    '--json',
  ]);
  assert.equal(toolsResult.status, 0, toolsResult.stderr || toolsResult.stdout);
  const toolList = JSON.parse(toolsResult.stdout);
  const tools = toolList.tools;
  assert.match(toolList.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    tools.map(({ name }) => name),
    ['timeline.read', 'timeline.trim'],
  );

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.addInitScript(() => {
    globalThis.__oaWebMcpTools = [];
    Object.defineProperty(globalThis.document, 'modelContext', {
      configurable: true,
      value: {
        registerTool(definition) {
          globalThis.__oaWebMcpTools.push(definition);
        },
      },
    });
  });
  await page.goto(session.url);
  await page.getByRole('heading', { level: 1, name: input.project.name }).waitFor();
  await page.waitForFunction(() => globalThis.__oaWebMcpTools?.length === 2);
  assert.deepEqual(
    await page.evaluate(() => globalThis.__oaWebMcpTools.map(({ name }) => name).sort()),
    ['timeline.read', 'timeline.trim'],
  );
  const projectedRead = await page.evaluate(() =>
    globalThis.__oaWebMcpTools.find(({ name }) => name === 'timeline.read').execute({}),
  );
  assert.equal(projectedRead.output.timeline.id, input.timeline.id);
  await page.getByRole('button', { name: /Select Studio opening annotation range/ }).click();
  await page.getByText('Studio opening · selected range', { exact: true }).waitFor();
  await page.getByLabel('Tell an Agent what matters here').fill('Keep only the useful opening.');
  await page.getByRole('button', { name: 'Create annotation' }).click();
  await page.getByText('Keep only the useful opening.', { exact: true }).waitFor();

  const annotationResult = await fixture.runOa([
    'annotation',
    'list',
    '--instance',
    session.instanceId,
    '--json',
  ]);
  assert.equal(annotationResult.status, 0, annotationResult.stderr || annotationResult.stdout);
  const annotations = JSON.parse(annotationResult.stdout).annotations;
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].target.provider, 'video.clip-range');
  assert.equal(annotations[0].targetSnapshot.context.clipId, input.timeline.clipId);
  const resolvedAnnotation = await fixture.runOa([
    'annotation',
    'resolve',
    annotations[0].id,
    '--instance',
    session.instanceId,
    '--json',
  ]);
  assert.equal(
    resolvedAnnotation.status,
    0,
    resolvedAnnotation.stderr || resolvedAnnotation.stdout,
  );
  assert.equal(JSON.parse(resolvedAnnotation.stdout).resolution.status, 'resolved');

  const clip = page.getByTestId(`timeline-clip-${input.timeline.clipId}`);
  assert.equal(await clip.getAttribute('data-source-end-us'), String(input.media.durationUs));
  const beforeWidth = (await clip.boundingBox()).width;

  const trimmedEndUs = 1_000_000;
  const trimResult = await fixture.runOa([
    'tool',
    'call',
    'timeline.trim',
    '--instance',
    session.instanceId,
    '--base-revision',
    toolList.revision,
    '--data',
    JSON.stringify({
      clipId: input.timeline.clipId,
      sourceEndUs: trimmedEndUs,
      sourceStartUs: 0,
    }),
    '--json',
  ]);
  assert.equal(trimResult.status, 0, trimResult.stderr || trimResult.stdout);
  const trim = JSON.parse(trimResult.stdout);
  assert.equal(trim.output.range.sourceEndUs, trimmedEndUs);
  assert.match(trim.revision, /^[0-9a-f]{40}$/);

  await page.waitForFunction(
    ({ clipId, endUs }) =>
      globalThis.document
        .querySelector(`[data-testid="timeline-clip-${clipId}"]`)
        ?.getAttribute('data-source-end-us') === String(endUs),
    { clipId: input.timeline.clipId, endUs: trimmedEndUs },
  );
  const afterWidth = (await clip.boundingBox()).width;
  assert.ok(
    afterWidth < beforeWidth,
    `trim should visibly shorten clip: ${beforeWidth} → ${afterWidth}`,
  );

  const readResult = await fixture.runOa([
    'tool',
    'call',
    'timeline.read',
    '--instance',
    session.instanceId,
    '--data',
    '{}',
    '--json',
  ]);
  assert.equal(readResult.status, 0, readResult.stderr || readResult.stdout);
  const project = JSON.parse(readResult.stdout).output;
  assert.equal(project.timeline.tracks[0].clips[0].sourceRange.sourceEndUs, trimmedEndUs);
  const persistedBeforeReload = JSON.parse(
    await readFile(resolve(session.bundlePath, 'data', 'project.json'), 'utf8'),
  );
  assert.equal(
    persistedBeforeReload.timeline.tracks[0].clips[0].sourceRange.sourceEndUs,
    trimmedEndUs,
  );

  await page.reload();
  await page.getByRole('heading', { level: 1, name: input.project.name }).waitFor();
  await page.getByTestId('project-status').filter({ hasText: 'synced' }).waitFor();
  const persistedAfterReload = JSON.parse(
    await readFile(resolve(session.bundlePath, 'data', 'project.json'), 'utf8'),
  );
  assert.equal(
    persistedAfterReload.timeline.tracks[0].clips[0].sourceRange.sourceEndUs,
    trimmedEndUs,
  );
  assert.equal(
    await page
      .getByTestId(`timeline-clip-${input.timeline.clipId}`)
      .getAttribute('data-source-end-us'),
    String(trimmedEndUs),
  );
  await page.getByRole('tab', { name: /Tools/ }).click();
  await page.getByText('timeline.trim', { exact: true }).waitFor();

  const stop = await fixture.runOa(['session', 'stop', session.sessionId, '--json']);
  assert.equal(stop.status, 0, stop.stderr || stop.stdout);
  stopped = true;
  const manifest = JSON.parse(await readFile(resolve(session.bundlePath, 'instance.json'), 'utf8'));
  assert.equal(manifest.state, 'stopped');
});
