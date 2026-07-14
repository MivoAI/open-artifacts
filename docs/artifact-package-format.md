# Artifact Package format for `react-render/v0`

Status: working draft implemented by the local Open Artifacts workbench.

## 1. Package identity

An Artifact Package MUST be an npm package. `package.json` is the only manifest and MUST contain:

```json
{
  "name": "@scope/example",
  "version": "0.1.0",
  "type": "module",
  "files": ["src", "input.schema.json", "example.json", "tsconfig.json", "README.md"],
  "exports": {
    ".": "./src/index.tsx",
    "./schema": "./input.schema.json",
    "./example": "./example.json",
    "./package.json": "./package.json"
  },
  "openArtifacts": {
    "format": "react-render/v0"
  },
  "peerDependencies": {
    "react": "^19.0.0"
  }
}
```

The package MUST publish its source entry. A compiled `dist` MAY also exist, but it MUST NOT be the
only editable implementation shipped to users.

## 2. Fixed resources

| Path                | Requirement                                               |
| ------------------- | --------------------------------------------------------- |
| `src/index.tsx`     | Default React source entry                                |
| `input.schema.json` | JSON Schema 2020-12 for Artifact Input                    |
| `example.json`      | Immediately previewable JSON input                        |
| `tsconfig.json`     | Standalone TypeScript configuration for a local fork      |
| `README.md`         | Package purpose, data shape, dependencies, and fork notes |

These paths are fixed in v0 to reduce configuration and make a copied directory predictable.

## 3. Runtime interface

The default export MUST be a React component that accepts one object prop named `data`:

```tsx
export default function Render({ data }: { data: MyInput }) {
  return <main />;
}
```

`data` MUST be JSON-compatible. A package MUST NOT require Host callbacks, contexts, registries, or
private workspace imports to produce its primary render. Internal React state and interactions are
allowed.

## 4. Dependency rules

- `react` MUST be a peer dependency and MUST NOT appear in `dependencies`.
- Package-specific libraries MUST be declared in that package's `dependencies`.
- Source MAY import files inside its own directory and declared npm dependencies.
- Source MUST NOT import a Host application, sibling Artifact Package, or undeclared workspace module.
- Styles and assets SHOULD be scoped under a package-specific root to reduce in-process collisions.

## 5. Schema and example

`input.schema.json` MUST declare JSON Schema draft 2020-12. Its references SHOULD remain package-local.
`example.json` MUST be valid JSON, SHOULD validate against the schema, and MUST complete a smoke
render through the public package export.

Schema validation is a Host responsibility. A package MAY perform additional defensive handling but
MUST NOT replace its public JSON Schema with an opaque runtime-only validator.

## 6. Fork locality

Copying a package directory MUST preserve all implementation knowledge needed to understand, build,
and edit the render. A local fork changes its directory and npm name, runs `npm install`, then can be
discovered without adding a manual import to the workbench:

```bash
cp -R packages/artifact-example packages/artifact-my-render
```

The fork MUST rename `package.json.name` to remain unique in an npm workspace and restart the Host
after installation so its source catalog is regenerated.

## 7. Trust model

`react-render/v0` identifies an execution and packaging convention, not a sandbox. Hosts MUST treat
in-process packages as trusted code. The format does not enforce permissions for DOM, CSS, network,
storage, clipboard, or other browser capabilities.

## 8. Conformance checks

A conforming package should pass all of these observable checks:

1. npm exports resolve to source, schema, and example inside the package.
2. npm `files` publishes those resources and a standalone TypeScript configuration.
3. React is a peer and is not duplicated as an implementation dependency.
4. The example can be imported and rendered through the default source export.
5. Package source has no Host or sibling Artifact Package import.
6. Copying the directory does not require a Host registry edit.

The repository enforces the first four checks in `e2e/artifact-package-*.test.*`.
