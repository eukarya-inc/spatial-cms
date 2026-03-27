import { Prisma } from "@prisma/client";
import prisma from "../db/client.js";

// GeoJSON geometry type (simplified)
interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/** Set geometry on an entity from GeoJSON */
export async function setEntityGeometry(
  entityId: string,
  geojson: GeoJsonGeometry,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE entity
    SET geometry = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geojson)}), 4326)
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
      properties: Prisma.JsonValue;
      status: string;
      geojson: string | null;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT id, type, properties, status,
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
    properties: row.properties,
    status: row.status,
    geometry: row.geojson ? JSON.parse(row.geojson) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Find entities within a bounding box [minLon, minLat, maxLon, maxLat] */
export async function findEntitiesInBBox(
  bbox: [number, number, number, number],
): Promise<string[]> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM entity
    WHERE geometry && ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326)
  `;
  return rows.map((r) => r.id);
}

/** Find entities within a radius (meters) of a point */
export async function findEntitiesNearPoint(
  lon: number,
  lat: number,
  radiusMeters: number,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM entity
    WHERE ST_DWithin(
      geometry::geography,
      ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
      ${radiusMeters}
    )
  `;
  return rows.map((r) => r.id);
}
