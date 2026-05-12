-- Workspace: intra-deployment grouping for unrelated demo/project data.
-- All existing data migrates into a "default" workspace.

-- 1. Workspace table
CREATE TABLE "workspace" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_slug_key" ON "workspace"("slug");

-- 2. Default workspace (every existing record will belong here)
INSERT INTO "workspace" ("slug", "name", "description")
VALUES ('default', 'Default', 'Initial workspace — existing data migrated here.');

-- 3. Add nullable workspace_id columns
ALTER TABLE "model_definition" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "dataset_definition" ADD COLUMN "workspace_id" UUID;

-- 4. Backfill: every existing row → default workspace
UPDATE "model_definition"
SET "workspace_id" = (SELECT "id" FROM "workspace" WHERE "slug" = 'default')
WHERE "workspace_id" IS NULL;

UPDATE "dataset_definition"
SET "workspace_id" = (SELECT "id" FROM "workspace" WHERE "slug" = 'default')
WHERE "workspace_id" IS NULL;

-- 5. Tighten to NOT NULL + foreign keys
ALTER TABLE "model_definition" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "dataset_definition" ALTER COLUMN "workspace_id" SET NOT NULL;

ALTER TABLE "model_definition"
  ADD CONSTRAINT "model_definition_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dataset_definition"
  ADD CONSTRAINT "dataset_definition_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "model_definition_workspace_id_idx" ON "model_definition"("workspace_id");
CREATE INDEX "dataset_definition_workspace_id_idx" ON "dataset_definition"("workspace_id");

-- 6. Replace global-unique on (key, name) with per-workspace unique.
-- This lets the same "building" model key live in different workspaces.
DROP INDEX IF EXISTS "model_definition_key_key";
DROP INDEX IF EXISTS "dataset_definition_name_key";
CREATE UNIQUE INDEX "model_definition_workspace_id_key_key" ON "model_definition"("workspace_id", "key");
CREATE UNIQUE INDEX "dataset_definition_workspace_id_name_key" ON "dataset_definition"("workspace_id", "name");
