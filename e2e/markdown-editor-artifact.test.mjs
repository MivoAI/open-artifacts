import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { buildCli, repositoryRoot, stopSession } from './helpers/cli.mjs';
import { createPackedCliFixture } from './helpers/packed-cli.mjs';

const artifactRoot = resolve(repositoryRoot, 'packages/artifact-markdown-editor');
const input = JSON.parse(await readFile(resolve(artifactRoot, 'example.json'), 'utf8'));

test.before(buildCli);

test('Markdown Editor turns a text-block selection into an actionable Annotation', async (t) => {
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

  const toolsResult = await fixture.runOa([
    'tool',
    'list',
    '--instance',
    session.instanceId,
    '--json',
  ]);
  assert.equal(toolsResult.status, 0, toolsResult.stderr || toolsResult.stdout);
  const toolList = JSON.parse(toolsResult.stdout);
  assert.match(toolList.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    toolList.tools.map(({ name }) => name),
    ['document.read', 'document.replaceBlock'],
  );

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(session.url);
  await page.getByRole('heading', { level: 1, name: input.title }).waitFor();
  await page.getByRole('button', { name: 'Pointer' }).waitFor();
  await page.getByRole('button', { name: 'Inspect' }).click();
  await page.getByText(/Inspector active.*Cmd\/Ctrl.*multi-select/).waitFor();

  const sourceTitle = page.getByRole('heading', { level: 2, name: 'Markdown source' });
  const sourceEditor = page.getByRole('textbox', { name: 'Markdown source' });
  await sourceTitle.hover();
  assert.equal(await sourceTitle.getAttribute('data-oa-inspector-hovered'), 'true');
  await sourceTitle.click();
  assert.equal(await sourceTitle.getAttribute('data-oa-inspector-selected'), 'true');
  await sourceEditor.click({ modifiers: ['ControlOrMeta'] });
  assert.equal(await sourceEditor.getAttribute('data-oa-inspector-selected'), 'true');
  await sourceEditor.click({ modifiers: ['ControlOrMeta'] });
  assert.equal(await sourceEditor.getAttribute('data-oa-inspector-selected'), null);
  await sourceEditor.click({ modifiers: ['ControlOrMeta'] });
  assert.equal(await sourceEditor.getAttribute('data-oa-inspector-selected'), 'true');
  await page.getByText('2 elements selected', { exact: true }).waitFor();
  await page
    .getByLabel('Tell an Agent what matters here')
    .fill('Keep the source label and editor aligned.');
  await page.getByRole('button', { name: 'Create annotation' }).click();
  await page.getByText('Keep the source label and editor aligned.', { exact: true }).waitFor();

  const fallbackText = page.locator('.md-preview-pane .md-pane-heading small');
  await fallbackText.evaluate((element) => {
    const text = element.firstChild;
    if (!text?.textContent) throw new Error('Fallback text node is missing');
    const range = globalThis.document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent.length);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new globalThis.MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByText('Text selected', { exact: true }).waitFor();
  assert.equal(await fallbackText.getAttribute('data-oa-inspector-selected'), 'true');

  const packageTargetBlock = page
    .locator('.md-block-paragraph')
    .filter({ hasText: 'Introduce the collaborative editing flow' })
    .first();
  await packageTargetBlock.locator('pre').click();
  await page.getByText('markdown.block-range', { exact: true }).waitFor();
  assert.equal(await fallbackText.getAttribute('data-oa-inspector-selected'), null);
  assert.equal(await sourceTitle.getAttribute('data-oa-inspector-selected'), null);
  assert.equal(await sourceEditor.getAttribute('data-oa-inspector-selected'), null);
  await page.keyboard.press('Escape');
  assert.equal(
    await page.getByRole('button', { name: 'Pointer' }).getAttribute('aria-pressed'),
    'true',
  );

  const selectionActions = page.getByRole('toolbar', { name: 'Text selection actions' });
  const addAnnotation = page.getByRole('button', { name: 'Add annotation' });
  await packageTargetBlock.focus();
  await page.keyboard.press('Enter');
  await selectionActions.waitFor();
  await page.waitForFunction(
    () => globalThis.document.activeElement?.textContent?.trim() === 'Add annotation',
  );
  assert.equal(
    await addAnnotation.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  await selectionActions.waitFor({ state: 'hidden' });
  assert.equal(
    await packageTargetBlock.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  await page.keyboard.press('Enter');
  await selectionActions.waitFor();
  await page.locator('.oa-stage').evaluate((element) => {
    element.dispatchEvent(new globalThis.Event('scroll'));
  });
  await selectionActions.waitFor({ state: 'hidden' });
  assert.equal(
    await packageTargetBlock.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );

  const selectedText = 'collaborative editing flow';
  const goalParagraph = packageTargetBlock;
  await goalParagraph.locator('pre').evaluate((element, phrase) => {
    const text = element.firstChild;
    if (!text?.textContent) throw new Error('Preview text node is missing');
    const start = text.textContent.indexOf(phrase);
    if (start < 0) throw new Error(`Selection phrase is missing: ${phrase}`);
    const range = globalThis.document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + phrase.length);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element
      .closest('article')
      ?.dispatchEvent(new globalThis.MouseEvent('mouseup', { bubbles: true }));
  }, selectedText);

  await selectionActions.waitFor();
  assert.equal(await page.getByText(selectedText, { exact: true }).count(), 0);
  await addAnnotation.click();
  await selectionActions.waitFor({ state: 'hidden' });
  await page.getByText(selectedText, { exact: true }).waitFor();
  const annotationBody = page.getByLabel('Tell an Agent what matters here');
  await annotationBody.waitFor();
  await page.waitForFunction(() => globalThis.document.activeElement?.id === 'oa-annotation-body');
  assert.equal(
    await annotationBody.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  await annotationBody.fill('Make this sentence more direct and concrete.');
  await page.getByRole('button', { name: 'Create annotation' }).click();
  await page.getByText('Make this sentence more direct and concrete.', { exact: true }).waitFor();

  const listed = await fixture.runOa([
    'annotation',
    'list',
    '--instance',
    session.instanceId,
    '--json',
  ]);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const annotations = JSON.parse(listed.stdout).annotations;
  assert.equal(annotations.length, 2);
  const inspectorAnnotation = annotations.find(
    (candidate) => candidate.target.provider === 'oa.dom-inspector',
  );
  assert.ok(inspectorAnnotation);
  assert.equal(inspectorAnnotation.targetSnapshot.context.count, 2);
  assert.equal(inspectorAnnotation.target.selector.items.length, 2);
  const resolvedInspector = await fixture.runOa([
    'annotation',
    'resolve',
    inspectorAnnotation.id,
    '--instance',
    session.instanceId,
    '--json',
  ]);
  assert.equal(resolvedInspector.status, 0, resolvedInspector.stderr || resolvedInspector.stdout);
  assert.equal(JSON.parse(resolvedInspector.stdout).resolution.status, 'unsupported');
  const annotation = annotations.find(
    (candidate) => candidate.target.provider === 'markdown.block-range',
  );
  assert.ok(annotation);
  assert.equal(annotation.target.provider, 'markdown.block-range');
  assert.equal(annotation.targetSnapshot.context.selectedText, selectedText);
  assert.equal(annotation.targetSnapshot.context.startLine, 5);
  const resolvedAnnotation = await fixture.runOa([
    'annotation',
    'resolve',
    annotation.id,
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

  const replacement = 'Explain the collaborative editing flow with one concrete outcome.';
  const replaced = await fixture.runOa([
    'tool',
    'call',
    'document.replaceBlock',
    '--instance',
    session.instanceId,
    '--base-revision',
    toolList.revision,
    '--data',
    JSON.stringify({
      markdown: replacement,
      selector: annotation.target.selector,
    }),
    '--json',
  ]);
  assert.equal(replaced.status, 0, replaced.stderr || replaced.stdout);
  assert.match(JSON.parse(replaced.stdout).revision, /^[0-9a-f]{40}$/);

  await page.getByText(replacement, { exact: true }).waitFor();
  assert.match(
    await page.getByRole('textbox', { name: 'Markdown source' }).inputValue(),
    new RegExp(replacement),
  );

  const readResult = await fixture.runOa([
    'tool',
    'call',
    'document.read',
    '--instance',
    session.instanceId,
    '--data',
    '{}',
    '--json',
  ]);
  assert.equal(readResult.status, 0, readResult.stderr || readResult.stdout);
  assert.match(JSON.parse(readResult.stdout).output.markdown, new RegExp(replacement));

  await page.reload();
  await page.getByText(replacement, { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Pointer' }).getAttribute('aria-pressed'),
    'true',
  );
  await page.getByRole('tab', { name: /Annotations/ }).click();
  await page.getByText('Make this sentence more direct and concrete.', { exact: true }).waitFor();

  const stop = await fixture.runOa(['session', 'stop', session.sessionId, '--json']);
  assert.equal(stop.status, 0, stop.stderr || stop.stdout);
  stopped = true;
  assert.equal(
    JSON.parse(await readFile(resolve(session.bundlePath, 'instance.json'), 'utf8')).state,
    'stopped',
  );
});
