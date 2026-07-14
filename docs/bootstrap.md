# Bootstrap Checklist

The preferred path from `onee-workspace` is:

```bash
make create-product name=my-product
```

That command creates and clones the GitHub repository, initializes the template through `npm install`, verifies the project, publishes the initialized commit, and registers the clone with the local workspace.

When creating a repository directly through GitHub's template interface, initialize it locally with:

```bash
npm install
```

The project name is derived from the clone directory. Use `ONEE_PROJECT_SCOPE=<scope>` or `ONEE_PROJECT_TITLE="Project Title"` on the same `npm install` command to override its derived metadata. Re-running `npm install` is safe; initialization is idempotent and refuses to overwrite custom workspace package names.

## Repository

- Choose whether `apps/web` should use Next.js, Vite, Astro, Remix, or another stack.
- Add required environment variables to `.env.example`.

## GitHub

- Make the repository public or private according to project needs.
- Enable **Template repository** only for repositories meant to be reused as templates.
- Add branch protection or repository rulesets.
- Require the `Quality` workflow before merging.
- Create and protect the `model-eval` GitHub Environment, restrict deployments to `main`, and require approval when model spend warrants it.
- Store model credentials as `model-eval` environment secrets, not repository-level secrets.
- Decide whether model evals are required for main, releases, or manual acceptance.
- Configure other required secrets and environments.
- Decide whether releases are manual, tag-based, or automated.

## Local

```bash
npm install
npm run lint
npm run test
npm run e2e
```
