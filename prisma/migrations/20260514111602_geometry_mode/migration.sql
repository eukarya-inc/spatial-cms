-- Replace the geometry_is_3d boolean with an explicit geometry_mode column
-- ("2D" | "2.5D" | "3D") and add height_field_key + base_height_field_key
-- for 2.5D extrusion.
--
-- Why TEXT + CHECK rather than a Postgres enum: enum values "2D", "2.5D", "3D"
-- are universal in GIS but invalid as TypeScript identifiers, so a Prisma enum
-- forces ugly mapped names like TWO_FIVE_D in the client. Plain TEXT + CHECK
-- keeps the wire format identical to the storage format.
--
-- Mapping (conservative — does NOT auto-detect 2.5D):
--   geometry_is_3d = TRUE  -> geometry_mode = '3D'
--   geometry_is_3d = FALSE -> geometry_mode = '2D'
--   geometry_is_3d = NULL  -> geometry_mode = NULL  (non-geometry fields)
--
-- Users who actually want 2.5D must explicitly upgrade their field in the
-- Model Designer and pick height_field_key (and optionally base_height_field_key).

ALTER TABLE "field_definition"
  ADD COLUMN "geometry_mode" TEXT,
  ADD COLUMN "height_field_key" TEXT,
  ADD COLUMN "base_height_field_key" TEXT,
  ADD CONSTRAINT "field_definition_geometry_mode_check"
    CHECK ("geometry_mode" IS NULL OR "geometry_mode" IN ('2D', '2.5D', '3D'));

UPDATE "field_definition"
  SET "geometry_mode" = CASE
    WHEN "geometry_is_3d" IS TRUE  THEN '3D'
    WHEN "geometry_is_3d" IS FALSE THEN '2D'
    ELSE NULL
  END
  WHERE "geometry_type" IS NOT NULL;

ALTER TABLE "field_definition" DROP COLUMN "geometry_is_3d";
