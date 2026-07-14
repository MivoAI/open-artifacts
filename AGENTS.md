# Agent Engineering Rules

## Project Shape

- Use `apps/*` for deployable or runnable applications.
- Use `packages/*` for reusable libraries and infrastructure.
- Keep the repository root for workspace config, CI, scripts, docs, and agent instructions only.
- Do not put product application source directly under root `src/`.

## Web App Slot

- `apps/web` is intentionally stack-neutral.
- Do not add Next.js, Vite, React, Astro, or any other web framework until the project chooses one explicitly.
- After a stack is chosen, keep framework-specific files inside `apps/web`.

## Project Bootstrap

- From `onee-workspace`, create new products with `make create-product name=<project-name>`.
- For direct GitHub template usage, clone into the intended lowercase kebab-case directory and run `npm install`.
- `npm install` derives the project name from the clone directory and initializes package names, workspace scope, lockfile, README, dependencies, and Git hooks.
- Do not manually search and replace `onee-product-template` or `@template/*`; keep identity changes in the install lifecycle scripts.
- Initialization is idempotent and must not overwrite custom workspace package names.

## Quality Gates

Before considering work complete, run the narrowest relevant check. For broad changes, run:

```bash
npm run lint
npm run test
npm run e2e
```

The deterministic quality chain is:

```text
lint -> test -> e2e
```

- `npm run lint`: deterministic static checks, including formatting, ESLint, and TypeScript.
- `npm run test`: isolated unit tests; do not call real external services or models.
- `npm run e2e`: integration tests across assembled application boundaries.
- `npm run eval`: evaluations that call real models with explicit datasets, rubrics, and pass thresholds. Do not replace those model calls with mocks.
- Run `npm run eval` explicitly or through the protected Model Eval workflow because it can consume credentials and incur model cost.
- Keep these command names stable when adopting framework-specific runners.
- `npm run build` is a separate packaging/deployment check.

## Directory Boundaries

- `apps/android`: Android product slot; keep stack-neutral until the project selects native Android or a cross-platform framework.
- `apps/ios`: iOS product slot; keep stack-neutral until the project selects native iOS or a cross-platform framework.
- `apps/web`: user-facing web product.
- `apps/server`: backend service or API runtime.
- `packages/domain`: pure business rules.
- `packages/database`: persistence schema, migrations, models, repositories.
- `packages/ui`: reusable UI primitives/components.
- `packages/config`: typed shared configuration.
- `packages/testing`: test helpers and fixtures.
- `packages/utils`: small framework-agnostic utilities.

Keep features close to the app that owns them. Extract into `packages/*` only when code is reused or represents a stable boundary.
