-- entity_geometry relation table: all geometry fields get spatial indexing
-- Replaces the single geometry column on entity table

-- Step 1: Create entity_geometry table
CREATE TABLE entity_geometry (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   UUID NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  field_key   TEXT NOT NULL,
  geometry    geometry NOT NULL,
  UNIQUE(entity_id, field_key)
);
CREATE INDEX idx_entity_geometry_gist ON entity_geometry USING GIST(geometry);
CREATE INDEX idx_entity_geometry_entity ON entity_geometry(entity_id);
CREATE INDEX idx_entity_geometry_field ON entity_geometry(field_key);

-- Step 2: Migrate existing geometry data from entity.geometry to entity_geometry
-- Uses the model's primaryGeometryField as the field_key
INSERT INTO entity_geometry (id, entity_id, field_key, geometry)
SELECT
  gen_random_uuid(),
  e.id,
  COALESCE(md.primary_geometry_field, 'geometry'),
  e.geometry
FROM entity e
LEFT JOIN model_definition md ON md.id = e.model_definition_id
WHERE e.geometry IS NOT NULL;

-- Step 3: Drop geometry column and its constraints from entity table
ALTER TABLE entity DROP CONSTRAINT IF EXISTS enforce_srid_geometry;
ALTER TABLE entity DROP COLUMN IF EXISTS geometry;
