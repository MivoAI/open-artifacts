import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { chromium } from 'playwright';

import { buildCli, repositoryRoot, stopSession } from './helpers/cli.mjs';
import { createPackedCliFixture } from './helpers/packed-cli.mjs';

const artifactRoot = resolve(repositoryRoot, 'packages/artifact-video-editor');
const initialInput = {
  project: {
    name: 'Packed CLI review cut',
    sequence: 'OA / PACKED 009',
    status: 'Ready for agent pass',
  },
  agent: {
    eyebrow: 'Installed OA session',
    title: 'Review the mobile opening',
    summary: 'Start from captions, then coordinate a square social delivery.',
    tasks: ['Verify the packed CLI input', 'Review playback and timing', 'Approve the brief'],
    composerPlaceholder: 'Describe the installed CLI edit request…',
  },
  media: {
    id: 'demo-video',
    title: 'Packed source clip',
    kind: 'H.264 + AAC',
    durationSeconds: 1.466667,
    dimensions: '1280 × 856',
  },
  timeline: {
    title: 'Packed opening study',
    trackLabel: 'Picture packed',
  },
  brief: {
    treatments: ['captions'],
    targetPlatform: 'tiktok',
    aspectRatio: '9:16',
  },
};

test.before(buildCli);

test('oa serves a collaborative and synchronized Video Editor Artifact', async (t) => {
  const packedCli = await createPackedCliFixture();
  let browser;
  let sessionId;
  let sessionStopped = false;

  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (sessionId && !sessionStopped) {
          const stopped = await packedCli
            .runOa(['session', 'stop', sessionId, '--json'])
            .catch(() => undefined);
          if (!stopped || stopped.status !== 0) await stopSession(packedCli.home, sessionId);
        }
      } finally {
        await packedCli.dispose();
      }
    }
  });

  const result = await packedCli.runOa(
    ['run', artifactRoot, '--data', JSON.stringify(initialInput), '--json', '--no-open'],
    { timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;
  assert.equal(session.artifact.name, '@open-artifacts/video-editor');
  assert.equal(session.artifact.version, '0.1.0');
  assert.equal((await globalThis.fetch(`${session.url}__oa/health`)).status, 200);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 680 } });
  await page.goto(session.url);

  const editorBounds = await page.getByRole('main').boundingBox();
  assert.equal(editorBounds?.width, 1080);
  assert.equal(editorBounds?.height, 680);
  assert.deepEqual(
    await page.locator('html').evaluate((element) => ({
      horizontal: element.scrollWidth > element.clientWidth,
      vertical: element.scrollHeight > element.clientHeight,
    })),
    { horizontal: false, vertical: false },
  );

  for (const surface of [
    'project-bar',
    'agent-surface',
    'media-library',
    'preview-surface',
    'timeline-surface',
  ]) {
    await page.getByTestId(surface).waitFor({ state: 'visible' });
  }

  await page.getByRole('heading', { level: 1, name: initialInput.project.name }).waitFor();
  await page.getByText(initialInput.project.sequence, { exact: true }).waitFor();
  assert.equal(await page.getByTestId('project-status').textContent(), initialInput.project.status);
  assert.equal(await page.getByRole('checkbox', { name: 'Tighten pacing' }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: 'Captions' }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Music bed' }).isChecked(), false);
  assert.equal(await page.getByLabel('Target platform').inputValue(), 'tiktok');
  assert.equal(await page.getByLabel('Aspect ratio').inputValue(), '9:16');
  assert.deepEqual(
    await page.getByTestId('treatment-tracks').getByRole('listitem').allTextContents(),
    ['Captions'],
  );

  for (const locator of [
    page.getByTestId('project-bar'),
    page.getByTestId('agent-surface'),
    page.getByTestId('media-library'),
    page.getByTestId('preview-surface'),
    page.getByTestId('timeline-surface'),
    page.getByRole('button', { name: 'Export draft' }),
    page.getByRole('button', { name: 'Apply brief' }),
    page.getByRole('button', { name: 'Play preview' }),
    page.getByTestId('timeline-clip-demo-video'),
  ]) {
    await assertWithinViewport(locator, { width: 1080, height: 680 });
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

  const previewFrame = page.getByTestId('preview-frame');
  assert.equal(await previewFrame.getAttribute('data-aspect-ratio'), '9:16');
  await assertAspectRatio(previewFrame, 9 / 16, 'portrait');

  const applyBrief = page.getByRole('button', { name: 'Apply brief' });
  assert.equal(await applyBrief.isDisabled(), true);

  await page.getByRole('checkbox', { name: 'Captions' }).uncheck();
  await page.getByRole('checkbox', { name: 'Tighten pacing' }).check();
  await page.getByRole('checkbox', { name: 'Music bed' }).check();
  await page.getByLabel('Target platform').selectOption('instagram-reels');
  await page.getByLabel('Aspect ratio').selectOption('1:1');
  assert.equal(await applyBrief.isDisabled(), false);
  await applyBrief.click();

  assert.equal(await page.getByTestId('project-status').textContent(), 'Unexported changes');
  assert.equal(await previewFrame.getAttribute('data-aspect-ratio'), '1:1');
  assert.equal(
    await previewFrame.evaluate(
      (element) => element.ownerDocument.defaultView?.getComputedStyle(element).aspectRatio,
    ),
    '1 / 1',
  );
  await assertAspectRatio(previewFrame, 1, 'square');

  const summaries = page.getByTestId('conversation-summary');
  assert.equal(await summaries.count(), 1);
  assert.equal(await applyBrief.isDisabled(), true);
  await summaries.nth(0).getByText('Tighten pacing, Music bed', { exact: true }).waitFor();
  await summaries.nth(0).getByText('Instagram Reels · 1:1', { exact: true }).waitFor();

  const treatmentTracks = page.getByTestId('treatment-tracks');
  assert.deepEqual(await treatmentTracks.getByRole('listitem').allTextContents(), [
    'Tighten pacing',
    'Music bed',
  ]);

  const exportDraft = page.getByRole('button', { name: 'Export draft' });
  await exportDraft.focus();
  await exportDraft.click();
  const exportSummary = page.getByRole('dialog', { name: 'Export summary' });
  await exportSummary.getByText('Simulation only', { exact: true }).waitFor();
  await exportSummary.getByText('Instagram Reels · 1:1', { exact: true }).waitFor();
  await exportSummary.getByText('Tighten pacing, Music bed', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('project-status').textContent(), 'Unexported changes');
  assert.equal(await exportSummary.evaluate((element) => element.localName), 'dialog');
  assert.equal(await exportSummary.evaluate((element) => element.matches(':modal')), true);
  await page.keyboard.press('Escape');
  await exportSummary.waitFor({ state: 'hidden' });
  assert.equal(
    await exportDraft.evaluate((element) => element === element.ownerDocument.activeElement),
    true,
  );

  const listedResult = await packedCli.runOa(['session', 'list', '--json']);
  assert.equal(listedResult.status, 0, listedResult.stderr || listedResult.stdout);
  assert.equal(listedResult.stderr, '');
  const listed = JSON.parse(listedResult.stdout);
  assert.equal(listed.sessions.length, 1);
  assert.deepEqual(
    {
      artifact: listed.sessions[0].artifact,
      sessionId: listed.sessions[0].sessionId,
      status: listed.sessions[0].status,
      url: listed.sessions[0].url,
    },
    {
      artifact: session.artifact,
      sessionId: session.sessionId,
      status: 'active',
      url: session.url,
    },
  );
  assert.equal(Number.isNaN(Date.parse(listed.sessions[0].startedAt)), false);

  await page.reload();
  await page.getByRole('heading', { level: 1, name: initialInput.project.name }).waitFor();
  assert.equal(await page.getByTestId('project-status').textContent(), initialInput.project.status);
  assert.equal(await page.getByTestId('conversation-summary').count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Tighten pacing' }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: 'Captions' }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Music bed' }).isChecked(), false);
  assert.equal(await page.getByLabel('Target platform').inputValue(), 'tiktok');
  assert.equal(await page.getByLabel('Aspect ratio').inputValue(), '9:16');
  assert.equal(await page.getByTestId('preview-frame').getAttribute('data-aspect-ratio'), '9:16');
  assert.deepEqual(
    await page.getByTestId('treatment-tracks').getByRole('listitem').allTextContents(),
    ['Captions'],
  );
  assert.equal(await page.getByRole('dialog', { name: 'Export summary' }).count(), 0);

  await page.setViewportSize({ width: 1440, height: 900 });
  assert.deepEqual(await page.getByRole('main').evaluate(measureElement), {
    clientHeight: 900,
    clientWidth: 1440,
    scrollHeight: 900,
    scrollWidth: 1440,
  });

  const stopped = await packedCli.runOa(['session', 'stop', session.sessionId, '--json']);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.equal(stopped.stderr, '');
  assert.deepEqual(JSON.parse(stopped.stdout), {
    sessionId: session.sessionId,
    status: 'stopped',
  });
  sessionStopped = true;
  await expectUnreachable(session.url);

  const emptyList = await packedCli.runOa(['session', 'list', '--json']);
  assert.equal(emptyList.status, 0, emptyList.stderr || emptyList.stdout);
  assert.equal(emptyList.stderr, '');
  assert.deepEqual(JSON.parse(emptyList.stdout), { sessions: [] });
});

async function expectUnreachable(url) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      await response.body?.cancel();
    } catch {
      return;
    }
    await delay(25);
  }
  assert.fail(`expected ${url} to become unreachable`);
}

async function assertSelected(locator, expected) {
  assert.equal(await locator.getAttribute('aria-selected'), String(expected));
  assert.equal((await locator.getAttribute('class')).includes('is-selected'), expected);
}

async function assertAspectRatio(locator, expected, label) {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, `${label} preview frame is visible`);
  assert.ok(
    Math.abs(bounds.width / bounds.height - expected) < 0.02,
    `${label} frame=${bounds.width}x${bounds.height}`,
  );
}

async function assertWithinViewport(locator, viewport) {
  const bounds = await locator.boundingBox();
  const description = await locator.evaluate(
    (element) =>
      element.getAttribute('data-testid') ??
      element.getAttribute('aria-label') ??
      element.textContent,
  );
  assert.ok(bounds, 'key editor element is visible');
  assert.ok(bounds.x >= 0, `${description} starts left of viewport: x=${bounds.x}`);
  assert.ok(bounds.y >= 0, `${description} starts above viewport: y=${bounds.y}`);
  assert.ok(
    bounds.x + bounds.width <= viewport.width,
    `${description} extends beyond viewport width`,
  );
  assert.ok(
    bounds.y + bounds.height <= viewport.height,
    `${description} extends beyond viewport height: bottom=${bounds.y + bounds.height}`,
  );
}

function measureElement(element) {
  return {
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  };
}
