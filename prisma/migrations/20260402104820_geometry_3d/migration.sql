-- Enable 3D geometry support (GeometryZ)
ALTER TABLE entity ALTER COLUMN geometry TYPE geometry(GeometryZ, 4326)
USING ST_Force3D(geometry);
