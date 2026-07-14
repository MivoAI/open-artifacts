import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import DecisionBoard from '@open-artifacts/render-decision-board';
import decisionExample from '@open-artifacts/render-decision-board/example';
import EvidenceTrace from '@open-artifacts/render-evidence-trace';
import evidenceExample from '@open-artifacts/render-evidence-trace/example';

describe('Render Package runtime seam', () => {
  it('renders each package example through its public source export', () => {
    const decisionData = decisionExample as Parameters<typeof DecisionBoard>[0]['data'];
    const evidenceData = evidenceExample as Parameters<typeof EvidenceTrace>[0]['data'];
    const decisionMarkup = renderToStaticMarkup(
      createElement(DecisionBoard, { data: decisionData }),
    );
    const evidenceMarkup = renderToStaticMarkup(
      createElement(EvidenceTrace, { data: evidenceData }),
    );

    expect(decisionMarkup).toContain('Package 本身就是可执行的 React 源码');
    expect(evidenceMarkup).toContain('一条输入如何变成可 fork 的 React 页面');
  });
});
