-- Bind every API key strictly to one workspace. No more global keys.
--
-- Rationale: per the workspace-as-user-level-isolation design decision,
-- a key from workspace X must never be able to see or operate on workspace Y.
-- The `api_key` table previously had no workspace_id at all — any key with
-- sufficient scope could pivot to any workspace via X-Workspace-Key header.
--
-- Migration of existing keys (aggressive — user chose this path):
--   - admin scope:   keep working, set workspace_id = default workspace.
--                    Operators should create new admin keys for non-default
--                    workspaces post-migration.
--   - manage/delivery: revoked (set revoked_at). Forces users to recreate
--                      keys within the target workspace explicitly. Breaks
--                      cross-workspace integrations on purpose.

-- Step 1: add nullable column + FK so we can populate before NOT NULL
ALTER TABLE "api_key"
  ADD COLUMN "workspace_id" UUID;

-- Step 2: admin keys → default workspace (still functional, just scoped)
UPDATE "api_key"
  SET "workspace_id" = (SELECT id FROM "workspace" WHERE slug = 'default')
  WHERE scope = 'admin';

-- Step 3: manage/delivery keys → also pinned to default (so NOT NULL holds)
-- AND revoked (no longer usable). Users must recreate these.
UPDATE "api_key"
  SET "workspace_id" = (SELECT id FROM "workspace" WHERE slug = 'default'),
      "revoked_at"   = COALESCE("revoked_at", now())
  WHERE scope IN ('manage', 'delivery');

-- Step 4: lock down — NOT NULL + FK + index
ALTER TABLE "api_key" ALTER COLUMN "workspace_id" SET NOT NULL;

ALTER TABLE "api_key"
  ADD CONSTRAINT "api_key_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE INDEX "api_key_workspace_id_idx" ON "api_key"("workspace_id");
