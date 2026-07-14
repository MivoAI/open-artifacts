# Open Artifacts

Open Artifacts is a source-first format and local workbench for React renders. A **Render Package is
the renderer itself**: editable TSX source, npm dependencies, styles, an input schema, and example
JSON published together as one ordinary npm package.

The model is deliberately small:

```text
Render Package (source) + Render Input (JSON) -> React page
```

Annotation is not part of the required package interface. A host may add it later as an overlay.

## Run the workbench

```bash
npm install
npm run dev
```

The workbench discovers source packages under `packages/render-*` from their npm manifests. It
currently includes:

- `decision-board` — a high-density dashboard that owns its ECharts dependency;
- `evidence-trace` — an interactive evidence-to-decision view built with plain React.

Edit the JSON on the right to update the selected render immediately. Switch packages on the left to
prove that the host does not know either input model or visual implementation.

## Render Package v0

```text
packages/render-my-render/
├── package.json
├── README.md
├── input.schema.json
├── example.json
├── tsconfig.json
└── src/
    └── index.tsx
```

`package.json` is the only manifest. Its public interface is:

```json
{
  "exports": {
    ".": "./src/index.tsx",
    "./schema": "./input.schema.json",
    "./example": "./example.json",
    "./package.json": "./package.json"
  },
  "openArtifacts": {
    "format": "react-render/v0"
  }
}
```

The default source export accepts one prop:

```tsx
export default function Render({ data }: { data: MyInput }) {
  return <main>{/* any React and npm ecosystem code */}</main>;
}
```

React is a peer dependency supplied by the host. ECharts, React Flow, TanStack Table, Three.js, or
other implementation dependencies belong to the Render Package that uses them.

See [`docs/render-package-format.md`](docs/render-package-format.md) for the normative v0 contract.

## Fork a render

```bash
cp -R packages/render-decision-board packages/render-my-render
```

Change the copied `package.json` name to `@open-artifacts/render-my-render`, then edit `src/index.tsx`,
`input.schema.json`, and `example.json`. Run `npm install` and restart the workbench; its Vite plugin
discovers the npm manifest and loads public package exports without a manual registry entry.

## Repository structure

```text
open-artifacts/
├── apps/web/                # Thin discovery, JSON input, and mount host
├── packages/render-*/       # Forkable source Render Packages
├── packages/                # Other reusable libraries and infrastructure
├── e2e/                     # Package format and public runtime contract tests
├── docs/                    # Product, architecture, and format decisions
├── evals/                   # Real-model evaluations (not implemented yet)
└── scripts/                 # Workspace automation
```

## Quality commands

```bash
npm run lint
npm run test
npm run e2e
npm run build
```

`npm run eval` remains separate because it will call real models and is intentionally not implemented
until a model workflow and scoring contract exist.
