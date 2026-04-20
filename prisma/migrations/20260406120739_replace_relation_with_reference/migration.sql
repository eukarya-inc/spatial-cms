-- Add 'reference' to FieldType enum FIRST so subsequent statements can use it
ALTER TYPE "FieldType" ADD VALUE IF NOT EXISTS 'reference';

-- Add referenceModelKey column to field_definition
ALTER TABLE field_definition ADD COLUMN IF NOT EXISTS reference_model_key TEXT;

-- Rename any existing 'relation' values to 'reference' (no-op on fresh DB)
UPDATE field_definition SET field_type = 'reference' WHERE field_type = 'relation';

-- Drop relation_definition table (no-op on fresh DB)
DROP TABLE IF EXISTS relation_definition;

-- Drop RelationType enum if nothing references it
DROP TYPE IF EXISTS "RelationType";
