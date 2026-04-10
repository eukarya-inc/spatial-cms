import prisma from "../../db/client.js";
import {
  getEntityWithGeometry,
  setEntityGeometry,
  removeEntityGeometry,
  findEntitiesInBBox,
  findEntitiesNearPoint,
  getSridForType,
} from "../../shared/geometry.js";
import { findModelDefinitionByKey } from "../../shared/dynamic-validation.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

/** Check if a value looks like a GeoJSON geometry object */
function isGeometryValue(v: unknown): v is { type: string; coordinates: unknown } {
  return !!v && typeof v === "object" && "type" in (v as object) && "coordinates" in (v as object);
}

/**
 * Sync all geometry field values from properties to entity_geometry table.
 * Geometry values are removed from the returned non-geometry properties.
 * Returns { cleanProps, geometryEntries } where geometryEntries are to be written to entity_geometry.
 */
async function extractGeometries(
  modelDefinitionId: string,
  properties: Record<string, unknown>,
): Promise<{ cleanProps: Record<string, unknown>; geoEntries: Array<{ fieldKey: string; geojson: { type: string; coordinates: unknown }; srid: number }> }> {
  const geoFields = await prisma.fieldDefinition.findMany({
    where: { modelDefinitionId, fieldType: "geometry" },
  });
  const geoKeys = new Set(geoFields.map((f) => f.key));
  const cleanProps: Record<string, unknown> = {};
  const geoEntries: Array<{ fieldKey: string; geojson: { type: string; coordinates: unknown }; srid: number }> = [];

  for (const [key, value] of Object.entries(properties)) {
    if (geoKeys.has(key) && isGeometryValue(value)) {
      const field = geoFields.find((f) => f.key === key)!;
      geoEntries.push({ fieldKey: key, geojson: value, srid: field.geometrySrid ?? 4326 });
    } else {
      cleanProps[key] = value;
    }
  }
  return { cleanProps, geoEntries };
}

/** Write geometry entries to entity_geometry table */
async function syncGeometries(entityId: string, geoEntries: Array<{ fieldKey: string; geojson: { type: string; coordinates: unknown }; srid: number }>) {
  for (const entry of geoEntries) {
    await setEntityGeometry(entityId, entry.fieldKey, entry.geojson, entry.srid);
  }
}

interface ListOptions {
  type?: string;
  status?: string;
  modelDefinitionId?: string;
  page?: number;
  pageSize?: number;
  bbox?: [number, number, number, number];
  near?: { lon: number; lat: number; radius: number };
  sort?: { field: string; order: "asc" | "desc" };
}

export async function listEntities(options: ListOptions = {}) {
  const where: Record<string, unknown> = {};
  if (options.type) where.type = options.type;
  if (options.status) where.status = options.status;
  if (options.modelDefinitionId) where.modelDefinitionId = options.modelDefinitionId;

  // Spatial filtering: get matching IDs first, using model's SRID
  if (options.bbox || options.near) {
    // Resolve SRID from model type if available
    const srid = options.type ? await getSridForType(options.type) : 4326;
    let spatialIds: string[];
    if (options.bbox) {
      spatialIds = await findEntitiesInBBox(options.bbox, srid);
    } else {
      spatialIds = await findEntitiesNearPoint(
        options.near!.lon,
        options.near!.lat,
        options.near!.radius,
        srid,
      );
    }
    if (!spatialIds.length) {
      return { entities: [], pagination: { total: 0, page: 1, pageSize: options.pageSize || 100, totalPages: 0 } };
    }
    where.id = { in: spatialIds };
  }

  // Count total
  const total = await prisma.entity.count({ where });

  // Pagination
  const pageSize = Math.min(Math.max(options.pageSize || 100, 1), 100000);
  const page = Math.max(options.page || 1, 1);
  const totalPages = Math.ceil(total / pageSize);

  // Sort
  let orderBy: Record<string, string> = { createdAt: "desc" };
  if (options.sort) {
    // Sort by property requires fetching all then sorting in-memory
    // For now, support createdAt and updatedAt as DB-level sorts
    if (["createdAt", "updatedAt", "type", "status"].includes(options.sort.field)) {
      orderBy = { [options.sort.field]: options.sort.order };
    }
  }

  const rawEntities = await prisma.entity.findMany({
    where,
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  // Merge geometry from entity_geometry table into properties
  const { getEntityGeometries } = await import("../../shared/geometry.js");
  const entities = await Promise.all(
    rawEntities.map(async (e) => {
      const geos = await getEntityGeometries(e.id);
      if (Object.keys(geos).length === 0) return e;
      return { ...e, properties: { ...((e.properties as object) ?? {}), ...geos } };
    }),
  );

  return {
    entities,
    pagination: { total, page, pageSize, totalPages },
  };
}

export async function getEntity(id: string) {
  return getEntityWithGeometry(id);
}

export async function getEntityVersions(id: string) {
  return prisma.entityVersion.findMany({
    where: { entityId: id },
    orderBy: { versionNumber: "desc" },
  });
}

/** Restore an archived entity back to active */
export async function restoreEntity(id: string) {
  const entity = await prisma.entity.findUnique({ where: { id } });
  if (!entity) throw new NotFoundError("Entity");
  if (entity.status !== "archived") throw new BusinessError("Only archived entities can be restored");
  return prisma.entity.update({ where: { id }, data: { status: "active" } });
}

/** Permanently delete an archived entity (cannot be undone) */
export async function purgeEntity(id: string) {
  const entity = await prisma.entity.findUnique({ where: { id } });
  if (!entity) throw new NotFoundError("Entity");
  if (entity.status !== "archived") throw new BusinessError("Only archived entities can be purged");

  // Disconnect proposals (keep audit trail but remove FK)
  await prisma.proposal.updateMany({ where: { entityId: id }, data: { entityId: null } });
  // Delete versions
  await prisma.entityVersion.deleteMany({ where: { entityId: id } });
  // Delete entity (cascade deletes entity_geometry rows)
  await prisma.entity.delete({ where: { id } });
  return { purged: true, id };
}

// Direct entity creation is intentionally NOT exposed.
// Entities are created/modified through the proposal system.
// This helper is used internally by the proposal approval flow.
export async function createEntityInternal(data: {
  type: string;
  modelDefinitionId?: string;
  properties?: Record<string, unknown>;
  status?: "draft" | "active" | "archived";
}) {
  // Resolve modelDefinitionId from type if not provided
  let modelDefId = data.modelDefinitionId;
  let type = data.type;

  if (modelDefId) {
    const model = await prisma.modelDefinition.findUnique({ where: { id: modelDefId } });
    if (model) type = model.key;
  } else if (type) {
    const model = await findModelDefinitionByKey(type);
    if (model) modelDefId = model.id;
  }

  // Separate geometry fields from regular properties
  let cleanProps = data.properties ?? {};
  let geoEntries: Array<{ fieldKey: string; geojson: { type: string; coordinates: unknown }; srid: number }> = [];
  if (modelDefId && data.properties) {
    const extracted = await extractGeometries(modelDefId, data.properties);
    cleanProps = extracted.cleanProps;
    geoEntries = extracted.geoEntries;
  }

  const entity = await prisma.entity.create({
    data: {
      type,
      modelDefinitionId: modelDefId,
      properties: cleanProps as any,
      status: data.status ?? "active",
    },
  });

  // Write geometry values to entity_geometry table (spatial indexed)
  await syncGeometries(entity.id, geoEntries);

  // Snapshot preserves geometry as historical record (geometry may change later)
  await prisma.entityVersion.create({
    data: {
      entityId: entity.id,
      versionNumber: 1,
      snapshot: ({
        type,
        properties: { ...cleanProps, ...Object.fromEntries(geoEntries.map((g) => [g.fieldKey, g.geojson])) },
      }) as any,
    },
  });

  return getEntityWithGeometry(entity.id);
}

export async function updateEntityInternal(
  id: string,
  changes: {
    type?: string;
    properties?: Record<string, unknown>;
    status?: "draft" | "active" | "archived";
  },
) {
  let snapshotProps: Record<string, unknown> = {};

  // Use transaction to prevent race conditions on properties merge and version number
  await prisma.$transaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id } });

    const updateData: Record<string, unknown> = {};
    if (changes.type) updateData.type = changes.type;
    if (changes.status) updateData.status = changes.status;

    // Merge non-geometry properties
    let mergedClean = (entity.properties as Record<string, unknown>) ?? {};
    if (changes.properties) {
      // Incoming properties may contain geometry values — separate them
      // (geometry sync happens outside transaction via entity_geometry table)
      const incoming = { ...changes.properties };
      mergedClean = { ...mergedClean, ...incoming };
      updateData.properties = mergedClean;
    }

    if (Object.keys(updateData).length > 0) {
      await tx.entity.update({ where: { id }, data: updateData });
    }

    const latestVersion = await tx.entityVersion.findFirst({
      where: { entityId: id },
      orderBy: { versionNumber: "desc" },
    });
    const nextVersion = (latestVersion?.versionNumber ?? 0) + 1;

    // Snapshot: merge clean props + geometry values for historical record
    snapshotProps = mergedClean;

    await tx.entityVersion.create({
      data: {
        entityId: id,
        versionNumber: nextVersion,
        snapshot: ({
          type: changes.type ?? entity.type,
          properties: snapshotProps,
        }) as any,
      },
    });
  });

  // Sync geometry fields to entity_geometry table
  if (changes.properties) {
    const ent = await prisma.entity.findUnique({ where: { id } });
    if (ent?.modelDefinitionId) {
      const { geoEntries } = await extractGeometries(ent.modelDefinitionId, changes.properties);
      await syncGeometries(id, geoEntries);
    }
  }

  // Patch snapshot with current geometries (for historical record)
  const { getEntityGeometries } = await import("../../shared/geometry.js");
  const geos = await getEntityGeometries(id);
  if (Object.keys(geos).length > 0) {
    const latest = await prisma.entityVersion.findFirst({
      where: { entityId: id },
      orderBy: { versionNumber: "desc" },
    });
    if (latest) {
      const snap = latest.snapshot as Record<string, unknown>;
      const props = (snap.properties ?? {}) as Record<string, unknown>;
      await prisma.entityVersion.update({
        where: { id: latest.id },
        data: { snapshot: { ...snap, properties: { ...props, ...geos } } as any },
      });
    }
  }

  return await getEntityWithGeometry(id);
}
