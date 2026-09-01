# Markdown Editor Artifact

A source-first Markdown editor that exercises the `react-runtime/v1` Package contract.

The root export contains the React renderer. Runtime hosts load the server-safe `./activate`
subpath, which registers capabilities without importing React or CSS.

The Package binds `document.md` through the instance-scoped OA SDK, registers
`document.read` and `document.replaceBlock`, and describes precise text selections through the
`markdown.block-range` Target Provider. The textarea keeps unsaved typing as a Local Draft; Save
turns the draft into one logical Data commit.

```ts
const document = oa.data.bindText('document.md', { initial: input.markdown });
oa.tool.register({ name: 'document.read' /* schema and handler */ });
oa.annotation.registerTargetProvider({ name: 'markdown.block-range' /* describe and resolve */ });
```

The Package receives this scoped `oa` object from the Runtime. Revision, actor, and idempotency
envelopes remain Runtime concerns rather than Package call-site arguments.

In the Preview, drag across text inside one block to select an exact range. The Package supplies a
structural block key, absolute source positions, text quote evidence, line numbers, and the capture
revision. OA owns Annotation creation and storage.
