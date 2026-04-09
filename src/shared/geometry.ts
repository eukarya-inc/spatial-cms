import { Prisma } from "@prisma/client";
import prisma from "../db/client.js";

// GeoJSON geometry type (simplified)
interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/** Set PRIMARY geometry on an entity from GeoJSON (accepts both 2D and 3D, any SRID).
 *  The Entity.geometry column stores only the primary geometry field's value. */
export async function setEntityGeometry(
  entityId: string,
  geojson: GeoJsonGeometry,
  srid: number = 4326,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE entity
    SET geometry = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geojson)}), ${srid}::int)
    WHERE id = ${entityId}::uuid
  `;
}

/** Get entity geometry as GeoJSON, returns null if no geometry */
export async function getEntityGeometry(
  entityId: string,
): Promise<GeoJsonGeometry | null> {
  const result = await prisma.$queryRaw<{ geojson: string | null }[]>`
    SELECT ST_AsGeoJSON(geometry) as geojson
    FROM entity
    WHERE id = ${entityId}::uuid
  `;
  if (!result[0]?.geojson) return null;
  return JSON.parse(result[0].geojson);
}

/** Get entity with geometry as GeoJSON */
export async function getEntityWithGeometry(entityId: string) {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      type: string;
      model_definition_id: string | null;
      properties: Prisma.JsonValue;
      status: string;
      geojson: string | null;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT id, type, model_definition_id, properties, status,
           ST_AsGeoJSON(geometry) as geojson,
           created_at, updated_at
    FROM entity
    WHERE id = ${entityId}::uuid
  `;
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: row.id,
    type: row.type,
    modelDefinitionId: row.model_definition_id,
    properties: row.properties,
    status: row.status,
    geometry: row.geojson ? JSON.parse(row.geojson) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Find entities within a bounding box [min1, min2, max1, max2] with configurable SRID */
export async function findEntitiesInBBox(
  bbox: [number, number, number, number],
  srid: number = 4326,
): Promise<string[]> {
  const [min1, min2, max1, max2] = bbox;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM entity
    WHERE geometry && ST_MakeEnvelope(${min1}, ${min2}, ${max1}, ${max2}, ${srid}::int)
  `;
  return rows.map((r) => r.id);
}

/** Find entities within a radius (meters) of a point with configurable SRID */
export async function findEntitiesNearPoint(
  x: number,
  y: number,
  radiusMeters: number,
  srid: number = 4326,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM entity
    WHERE ST_DWithin(
      geometry::geography,
      ST_SetSRID(ST_MakePoint(${x}, ${y}), ${srid}::int)::geography,
      ${radiusMeters}
    )
  `;
  return rows.map((r) => r.id);
}

/** Look up SRID for a model type via its primary geometry field definition.
 *  Returns 4326 if no primary geometry field is configured. */
export async function getSridForType(type: string): Promise<number> {
  const model = await prisma.modelDefinition.findUnique({
    where: { key: type },
    include: { fields: true },
  });
  if (!model?.primaryGeometryField) return 4326;
  const geoField = model.fields.find(
    (f) => f.key === model.primaryGeometryField,
  );
  return geoField?.geometrySrid ?? 4326;
}
