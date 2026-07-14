# Evidence Trace Render

An interactive evidence-to-decision trace built with plain React. Its input contains `sources`,
model `claims` with source IDs, and `outcomes` with claim IDs. Clicking a claim highlights the inputs
and outcomes connected to it. See `input.schema.json` and `example.json` for the complete data shape.

This package has no visualization dependency: its component tree, interaction state, styles,
TypeScript configuration, schema, and example are all local to the directory.

## Fork locally

From the Open Artifacts repository root:

```bash
cp -R packages/artifact-evidence-trace packages/artifact-my-trace
```

Rename the copied npm package to `@open-artifacts/my-trace`, run `npm install` from the
repository root, and restart the workbench. The Host discovers the package from its npm manifest and
loads its public exports; no registry edit is required.

The published npm package includes TSX, CSS, schema, example, README, and its standalone `tsconfig`.
