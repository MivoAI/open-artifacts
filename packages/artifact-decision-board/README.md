# Decision Board Render

A high-density decision dashboard for an AI-generated brief. Its input contains `meta`, numeric
`metrics`, evidence-backed `claims`, execution `steps`, and next `actions`; the exact contract lives in
`input.schema.json` and a complete input is in `example.json`.

The package owns its React source, CSS, TypeScript configuration, and ECharts dependency. The default
export in `src/index.tsx` accepts only `{ data }` and imports no Host code.

## Fork locally

From the Open Artifacts repository root:

```bash
cp -R packages/artifact-decision-board packages/artifact-my-board
```

Rename the copied npm package to `@open-artifacts/my-board`, then run `npm install` from the
repository root and restart the workbench. Edit `src/index.tsx`, `input.schema.json`, and
`example.json` in place; no Host registry change is required.

The published npm package includes TSX, CSS, schema, example, README, and its standalone `tsconfig`.
