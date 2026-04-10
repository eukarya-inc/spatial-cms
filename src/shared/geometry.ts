import prisma from "../db/client.js";

// GeoJSON geometry type (simplified)
interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/** Upsert a geometry value for an entity field into entity_geometry table */
export async function setEntityGeometry(
  entityId: string,
  fieldKey: string,
  geojson: GeoJsonGeometry,
  srid: number = 4326,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO entity_geometry (id, entity_id, field_key, geometry)
    VALUES (gen_random_uuid(), ${entityId}::uuid, ${fieldKey},
            ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geojson)}), ${srid}::int))
    ON CONFLICT (entity_id, field_key)
    DO UPDATE SET geometry = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geojson)}), ${srid}::int)
  `;
}

/** Remove a geometry field from an entity */
export async function removeEntityGeometry(
  entityId: string,
  fieldKey: string,
): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM entity_geometry WHERE entity_id = ${entityId}::uuid AND field_key = ${fieldKey}
  `;
}

/** Get a single geometry field as GeoJSON */
export async function getEntityGeometry(
  entityId: string,
  fieldKey: string,
): Promise<GeoJsonGeometry | null> {
  const result = await prisma.$queryRaw<{ geojson: string | null }[]>`
    SELECT ST_AsGeoJSON(geometry) as geojson
    FROM entity_geometry
    WHERE entity_id = ${entityId}::uuid AND field_key = ${fieldKey}
  `;
  if (!result[0]?.geojson) return null;
  return JSON.parse(result[0].geojson);
}

/** Get all geometries for an entity as { fieldKey: GeoJSON } */
export async function getEntityGeometries(
  entityId: string,
): Promise<Record<string, GeoJsonGeometry>> {
  const rows = await prisma.$queryRaw<{ field_key: string; geojson: string }[]>`
    SELECT field_key, ST_AsGeoJSON(geometry) as geojson
    FROM entity_geometry
    WHERE entity_id = ${entityId}::uuid
  `;
  const result: Record<string, GeoJsonGeometry> = {};
  for (const row of rows) {
    if (row.geojson) result[row.field_key] = JSON.parse(row.geojson);
  }
  return result;
}

/** Get entity with all geometries merged into properties */
export async function getEntityWithGeometry(entityId: string) {
  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) return null;
  const geometries = await getEntityGeometries(entityId);
  const properties = { ...((entity.properties as object) ?? {}), ...geometries };
  return {
    id: entity.id,
    type: entity.type,
    modelDefinitionId: entity.modelDefinitionId,
    properties,
    status: entity.status,
    geometry: null as GeoJsonGeometry | null, // legacy compat — use properties instead
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

/** Find entities with geometry matching a bounding box.
 *  fieldKey filters which geometry field to query (default: all). */
export async function findEntitiesInBBox(
  bbox: [number, number, number, number],
  srid: number = 4326,
  fieldKey?: string,
): Promise<string[]> {
  const [min1, min2, max1, max2] = bbox;
  if (fieldKey) {
    const rows = await prisma.$queryRaw<{ entity_id: string }[]>`
      SELECT DISTINCT entity_id FROM entity_geometry
      WHERE field_key = ${fieldKey}
        AND geometry && ST_MakeEnvelope(${min1}, ${min2}, ${max1}, ${max2}, ${srid}::int)
    `;
    return rows.map((r) => r.entity_id);
  }
  const rows = await prisma.$queryRaw<{ entity_id: string }[]>`
    SELECT DISTINCT entity_id FROM entity_geometry
    WHERE geometry && ST_MakeEnvelope(${min1}, ${min2}, ${max1}, ${max2}, ${srid}::int)
  `;
  return rows.map((r) => r.entity_id);
}

/** Find entities within a radius (meters) of a point.
 *  fieldKey filters which geometry field to query (default: all). */
export async function findEntitiesNearPoint(
  x: number,
  y: number,
  radiusMeters: number,
  srid: number = 4326,
  fieldKey?: string,
): Promise<string[]> {
  if (fieldKey) {
    const rows = await prisma.$queryRaw<{ entity_id: string }[]>`
      SELECT DISTINCT entity_id FROM entity_geometry
      WHERE field_key = ${fieldKey}
        AND ST_DWithin(
          geometry::geography,
          ST_SetSRID(ST_MakePoint(${x}, ${y}), ${srid}::int)::geography,
          ${radiusMeters}
        )
    `;
    return rows.map((r) => r.entity_id);
  }
  const rows = await prisma.$queryRaw<{ entity_id: string }[]>`
    SELECT DISTINCT entity_id FROM entity_geometry
    WHERE ST_DWithin(
      geometry::geography,
      ST_SetSRID(ST_MakePoint(${x}, ${y}), ${srid}::int)::geography,
      ${radiusMeters}
    )
  `;
  return rows.map((r) => r.entity_id);
}

/** Look up SRID for a model type via its primary geometry field definition. */
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
