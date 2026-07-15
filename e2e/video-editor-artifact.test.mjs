import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { chromium } from 'playwright';

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/cli/index.js');
const artifactRoot = resolve(repositoryRoot, 'packages/artifact-video-editor');

function buildCli() {
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@open-artifacts/cli'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runCli(arguments_, home) {
  return spawnSync(process.execPath, [cliEntry, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    timeout: 30_000,
  });
}

async function stopSession(home, sessionId) {
  const sessionDirectory = join(home, '.open-artifacts', 'sessions', sessionId);
  const record = JSON.parse(await readFile(join(sessionDirectory, 'record.json'), 'utf8'));

  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }

  await rm(sessionDirectory, { force: true, recursive: true });
}

test('oa serves a playable and synchronized Video Editor Artifact', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-video-editor-'));
  let browser;
  let sessionId;

  t.after(async () => {
    await browser?.close();
    if (sessionId) await stopSession(home, sessionId);
    await rm(home, { force: true, recursive: true });
  });

  const result = runCli(['run', artifactRoot, '--json', '--no-open'], home);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(session.url);

  const editorBounds = await page.getByRole('main').boundingBox();
  assert.equal(editorBounds?.width, 1440);
  assert.ok((editorBounds?.height ?? 0) >= 900, `editor height=${editorBounds?.height}`);

  for (const surface of [
    'project-bar',
    'agent-surface',
    'media-library',
    'preview-surface',
    'timeline-surface',
  ]) {
    await page.getByTestId(surface).waitFor({ state: 'visible' });
  }

  const mediaCard = page.getByTestId('media-card-demo-video');
  const timelineClip = page.getByTestId('timeline-clip-demo-video');
  await mediaCard.click();
  await assertSelected(mediaCard, true);
  await assertSelected(timelineClip, true);

  await page.reload();
  await assertSelected(mediaCard, false);
  await timelineClip.click();
  await assertSelected(timelineClip, true);
  await assertSelected(mediaCard, true);

  const video = page.getByTestId('preview-video');
  const playToggle = page.getByRole('button', { name: 'Play preview' });
  await playToggle.click();
  const playbackDeadline = Date.now() + 5_000;
  let playbackTime = 0;
  while (Date.now() < playbackDeadline) {
    playbackTime = await video.evaluate((element) => element.currentTime);
    if (playbackTime > 0.1) break;
    await delay(50);
  }
  assert.ok(playbackTime > 0.1, `playback did not advance: currentTime=${playbackTime}`);
  assert.equal(await video.evaluate((element) => element.paused), false);

  await page.getByRole('button', { name: 'Pause preview' }).click();
  assert.equal(await video.evaluate((element) => element.paused), true);

  const scrubber = page.getByRole('slider', { name: 'Timeline scrubber' });
  await scrubber.fill('0.75');
  const scrubbedTime = await video.evaluate((element) => element.currentTime);
  assert.ok(scrubbedTime >= 0.65 && scrubbedTime <= 0.85, `currentTime=${scrubbedTime}`);
  assert.equal(await page.getByTestId('timeline-time').getAttribute('data-time'), '0.75');
  const playheadPercent = await page
    .getByTestId('timeline-playhead')
    .evaluate((element) => Number.parseFloat(element.style.left));
  assert.ok(playheadPercent >= 45 && playheadPercent <= 60, `left=${playheadPercent}%`);
});

async function assertSelected(locator, expected) {
  assert.equal(await locator.getAttribute('aria-selected'), String(expected));
  assert.equal((await locator.getAttribute('class')).includes('is-selected'), expected);
}
