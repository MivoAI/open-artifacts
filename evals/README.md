# Model Evaluations

Place evaluations that call real models here. The stable command is:

```bash
npm run eval
```

Use `*.test.ts` or `*.spec.ts`. Every suite should define:

- representative inputs and expected behavior
- the provider, model identifier, and relevant generation settings
- an explicit scoring rubric and pass threshold
- required credentials supplied through environment variables
- cost and rate-limit expectations

Do not replace model calls with mocks in this directory. Mocked model behavior is a unit or integration test, not an eval. Model evals run serially by default to reduce cost spikes and rate-limit failures.

The empty template intentionally makes `npm run eval` fail with "No test files found." A project has not established a model-quality contract until it adds a suite here that calls a real model and passes its declared threshold.
