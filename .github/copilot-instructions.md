# Copilot Instructions

## Post-Implementation Checks

After making any code changes, always run the following commands in order and fix any errors before finishing:

```bash
npm run check-types
npm run lint
npm run format
npm run test
```

- **`npm run check-types`** — TypeScript type-check (no emit). Fix all type errors before proceeding.
- **`npm run lint`** — Biome linter on `src/**/*.ts`. Fix or suppress all warnings/errors.
- **`npm run format`** — Biome formatter check on `src/**/*.ts`. Run `npm run format:fix` to auto-fix formatting issues.
- **`npm run test`** — Compiles tests and runs the full test suite via `vscode-test`. **All tests must pass.**