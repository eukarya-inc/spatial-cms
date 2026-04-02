# Spatial CMS — Tests

## Overview

Integration tests that verify the core governance workflow end-to-end. Tests run against a real database (not mocked), calling the actual Express API via HTTP.

Tests use a **separate database** (`spatial_cms_test`) so dev data is never affected.

## Prerequisites

- Docker running (`docker compose up -d`) with PostGIS on port 5434
- Test database created and migrated:
  ```bash
  docker compose exec db psql -U spatial_cms -c "CREATE DATABASE spatial_cms_test;"
  docker compose exec db psql -U spatial_cms -d spatial_cms_test -c "CREATE EXTENSION IF NOT EXISTS postgis;"
  npm run db:migrate:test
  ```

## Running Tests

```bash
# Run all tests
npm test

# Run in watch mode (re-runs on file changes)
npm run test:watch

# Run a specific test file
node --import tsx --test tests/integration/version-geometry.test.ts
```

## Test Structure

```
tests/
  helpers/
    api.ts          # Starts test server on random port, HTTP request helper
    setup.ts        # Database cleanup, test model/policy creation
  integration/
    version-geometry.test.ts   # Geometry preserved in version snapshots
    proposal-workflow.test.ts  # Proposal → approve/reject → entity lifecycle
    delivery-api.test.ts       # Pagination, bbox, GeoJSON, schema, filtering
    ingestion.test.ts          # Validate, import, governed, skipInvalid
```

## How It Works

1. Each test file starts a temporary Express server on a random port
2. `before()` cleans the database and creates test data (model, fields, policies)
3. Tests make HTTP requests to the API and assert on responses
4. `after()` stops the server

## Adding a New Test

When you fix a bug or add a feature:

1. Create a new `it()` block in the appropriate test file
2. Or create a new `tests/integration/feature-name.test.ts` file
3. Use `apiRequest()` from `tests/helpers/api.ts` for API calls
4. Use `cleanDatabase()` from `tests/helpers/setup.ts` to reset state

### Template

```typescript
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import { cleanDatabase, createTestModel } from "../helpers/setup.js";

describe("Feature name", () => {
  before(async () => {
    await startServer();
    await cleanDatabase();
    // ... create test data
  });

  after(async () => {
    await stopServer();
  });

  it("should do something", async () => {
    const { status, data } = await apiRequest("/endpoint", {
      method: "POST",
      body: { key: "value" },
    });
    assert.strictEqual(status, 200);
  });
});
```

## Convention

- Test files end with `.test.ts`
- Each test file is self-contained (sets up and tears down its own data)
- Tests run in parallel by default (each has its own server instance)
- Use descriptive `it()` messages that explain the expected behavior
