# Open Artifacts

Open Artifacts compiles structured AI output into portable, high-density web artifacts that people can
scan, annotate, and return to an AI as precise change requests.

The first Vite + React prototype validates one loop: edit an Artifact Package as JSON, render the same
data through three semantic layouts, select a visible block, and emit annotation JSON with a stable
target path.

## Run the prototype

```bash
npm install
npm run dev
```

Open the local URL and switch among:

- `?variant=atlas` — simultaneous high-density overview;
- `?variant=brief` — guided reading path;
- `?variant=trace` — evidence-to-action provenance.

The prototype is intentionally marked as throwaway. Its question and design hypotheses live in
[`apps/web/src/prototype/NOTES.md`](apps/web/src/prototype/NOTES.md). The durable product boundary is
defined in [`docs/product-brief.md`](docs/product-brief.md), with the competitive landscape in
[`docs/research/landscape.md`](docs/research/landscape.md) and the draft package contract in
[`docs/spec/artifact-package.v0.1.schema.json`](docs/spec/artifact-package.v0.1.schema.json).

## Structure

```text
open-artifacts/
├── apps/
│   ├── android/             # Empty Android app slot; choose a stack later
│   ├── ios/                 # Empty iOS app slot; choose a stack later
│   ├── server/              # Optional backend service slot
│   └── web/                 # Vite + React interaction prototype
├── packages/
│   ├── config/              # Shared configuration helpers
│   ├── database/            # Database schema/model/migration boundary
│   ├── domain/              # Business/domain logic
│   ├── testing/             # Shared test helpers
│   ├── ui/                  # Shared UI package, if needed
│   └── utils/               # Shared utilities
├── e2e/                     # Integration tests across system boundaries
├── evals/                   # Evaluations that call real models
├── docs/                    # Architecture and quality documentation
├── scripts/                 # Local automation
├── .github/                 # GitHub Actions
└── .githooks/               # Local git hooks
```

## Commands

```bash
npm install
npm run lint
npm run test
npm run e2e
npm run eval
npm run build
```

The four quality contracts are stable: `lint` is static analysis, `test` is unit testing, `e2e` is integration testing, and `eval` runs real-model evaluations. Run each command explicitly; `eval` remains separate because it uses model credentials and may incur cost. See `docs/quality-gates.md` for CI and credential boundaries.

On the first install in a repository created from this template, `npm install` derives the project name from the clone directory and updates the root package name, workspace package scope, lockfile, README, dependencies, and Git hooks. Later installs are idempotent. To override the derived scope or title, set `ONEE_PROJECT_SCOPE` or `ONEE_PROJECT_TITLE` on the same command.

```bash
ONEE_PROJECT_SCOPE=acme ONEE_PROJECT_TITLE="Acme Product" npm install
```

## GitHub Template Setup

From `onee-workspace`, create and initialize a public product repository with one command:

```bash
make create-product name=my-product
```

For a repository created directly through GitHub's template interface, clone it into the intended project directory and run `npm install` before beginning product work.

See `docs/bootstrap.md` for the setup checklist.
