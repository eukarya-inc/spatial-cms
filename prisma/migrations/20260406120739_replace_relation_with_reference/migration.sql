-- Add referenceModelKey to field_definition
ALTER TABLE field_definition ADD COLUMN IF NOT EXISTS reference_model_key TEXT;

-- Rename field type 'relation' to 'reference'
UPDATE field_definition SET field_type = 'reference' WHERE field_type = 'relation';

-- Update FieldType enum: remove 'relation', add 'reference'
ALTER TYPE "FieldType" ADD VALUE IF NOT EXISTS 'reference';

-- Drop relation_definition table
DROP TABLE IF EXISTS relation_definition;

-- Drop RelationType enum (may fail if still referenced, OK)
DROP TYPE IF EXISTS "RelationType";
