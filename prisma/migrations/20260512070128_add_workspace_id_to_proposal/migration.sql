-- Proposal gets its own workspace_id FK so cross-workspace isolation works
-- even when entity has been purged (orphan proposals from audit trail).
-- Without this, listProposals had to fuzzy-match by model.key, which leaks
-- between workspaces that happen to share key names like "building".

-- 1. Add nullable column
ALTER TABLE "proposal" ADD COLUMN "workspace_id" UUID;

-- 2. Backfill from entity → modelDefinition → workspace
UPDATE "proposal" p
SET "workspace_id" = m.workspace_id
FROM "entity" e
JOIN "model_definition" m ON e.model_definition_id = m.id
WHERE p.entity_id = e.id AND p.workspace_id IS NULL;

-- 3. Backfill orphans that carry a modelDefinitionId in proposed_change JSON
UPDATE "proposal" p
SET "workspace_id" = m.workspace_id
FROM "model_definition" m
WHERE p.workspace_id IS NULL
  AND p.entity_id IS NULL
  AND (p.proposed_change->'data'->>'modelDefinitionId')::uuid = m.id;

-- 4. Delete unrecoverable orphans (no entity, no modelDefinitionId — cannot
-- be attributed to any workspace). Test-environment cleanup.
DELETE FROM "proposal" WHERE "workspace_id" IS NULL;

-- 5. Tighten + FK + index
ALTER TABLE "proposal" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "proposal"
  ADD CONSTRAINT "proposal_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "proposal_workspace_id_idx" ON "proposal"("workspace_id");
