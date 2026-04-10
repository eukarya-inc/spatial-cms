-- Multi-geometry support: geometry properties move from model-level to field-level
-- ModelDefinition loses geometryType/is3D/srid, gains primaryGeometryField
-- FieldDefinition gains geometryType/geometrySrid/geometryIs3D for geometry fields

-- Step 1: Add new columns to field_definition
ALTER TABLE "field_definition" ADD COLUMN "geometry_type" "GeometryType";
ALTER TABLE "field_definition" ADD COLUMN "geometry_srid" INTEGER;
ALTER TABLE "field_definition" ADD COLUMN "geometry_is_3d" BOOLEAN;

-- Step 2: Add primaryGeometryField to model_definition
ALTER TABLE "model_definition" ADD COLUMN "primary_geometry_field" TEXT;

-- Step 3: Migrate existing model geometry config to a geometry field per model
-- For each model that has a geometry type != NONE, create a geometry field
INSERT INTO "field_definition" (id, model_definition_id, key, label, field_type, is_required, geometry_type, geometry_srid, geometry_is_3d, order_index)
SELECT
  gen_random_uuid(),
  md.id,
  'geometry',
  'Geometry',
  'geometry',
  false,
  md.geometry_type,
  md.srid,
  md.is_3d,
  -1
FROM model_definition md
WHERE md.geometry_type != 'NONE'
AND NOT EXISTS (
  SELECT 1 FROM field_definition fd WHERE fd.model_definition_id = md.id AND fd.key = 'geometry'
);

-- Step 4: Set primaryGeometryField for models with geometry
UPDATE model_definition SET primary_geometry_field = 'geometry'
WHERE geometry_type != 'NONE';

-- Step 5: Drop old columns from model_definition
ALTER TABLE "model_definition" DROP COLUMN "geometry_type";
ALTER TABLE "model_definition" DROP COLUMN "is_3d";
ALTER TABLE "model_definition" DROP COLUMN "srid";
