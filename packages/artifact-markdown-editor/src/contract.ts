import type { OaSdk } from '@open-artifacts/sdk';

export interface MarkdownEditorInput {
  markdown: string;
  title: string;
}

export function bindDocument(oa: OaSdk, input: Readonly<MarkdownEditorInput>) {
  return oa.data.bindText('document.md', {
    initial: input.markdown,
  });
}
