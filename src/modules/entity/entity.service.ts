import prisma from "../../db/client.js";
import {
  getEntityWithGeometry,
  setEntityGeometry,
  findEntitiesInBBox,
  findEntitiesNearPoint,
  getSridForType,
} from "../../shared/geometry.js";
import { findModelDefinitionByKey } from "../../shared/dynamic-validation.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

/**
 * Look up the primaryGeometryField's SRID from the field definition.
 * Returns 4326 as default if not found.
 */
async function getGeometryFieldSrid(
  modelDefinitionId: string,
  primaryGeometryField: string,
): Promise<number> {
  const field = await prisma.fieldDefinition.findUnique({
    where: {
      modelDefinitionId_key: {
        modelDefinitionId,
        key: primaryGeometryField,
      },
    },
  });
  return field?.geometrySrid ?? 4326;
}

/**
 * Given a model definition ID, resolve the primaryGeometryField key and
 * extract the geometry value from properties. Returns null if the model
 * has no primaryGeometryField or the property is not a geometry object.
 */
async function extractPrimaryGeometry(
  modelDefinitionId: string,
  properties: Record<string, unknown>,
): Promise<{ geojson: { type: string; coordinates: unknown }; srid: number } | null> {
  const model = await prisma.modelDefinition.findUnique({
    where: { id: modelDefinitionId },
  });
  if (!model?.primaryGeometryField) return null;

  const value = properties[model.primaryGeometryField];
  if (!value || typeof value !== "object" || !("type" in (value as object)) || !("coordinates" in (value as object))) {
    return null;
  }

  const srid = await getGeometryFieldSrid(modelDefinitionId, model.primaryGeometryField);
  return {
    geojson: value as { type: string; coordinates: unknown },
    srid,
  };
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

  const entities = await prisma.entity.findMany({
    where,
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

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
  // Delete entity (raw SQL because of Unsupported geometry column)
  await prisma.$executeRaw`DELETE FROM entity WHERE id = ${id}::uuid`;
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

  const entity = await prisma.entity.create({
    data: {
      type,
      modelDefinitionId: modelDefId,
      properties: (data.properties ?? {}) as any,
      status: data.status ?? "active",
    },
  });

  // Extract primaryGeometryField value from properties and sync to PostGIS column
  if (modelDefId && data.properties) {
    const geo = await extractPrimaryGeometry(modelDefId, data.properties);
    if (geo) {
      await setEntityGeometry(entity.id, geo.geojson, geo.srid);
    }
  }

  // Snapshot stores all properties (geometry values are inside properties)
  await prisma.entityVersion.create({
    data: {
      entityId: entity.id,
      versionNumber: 1,
      snapshot: ({
        type,
        modelDefinitionId: modelDefId ?? null,
        properties: data.properties ?? {},
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
  let mergedProps: unknown;

  // Use transaction to prevent race conditions on properties merge and version number
  await prisma.$transaction(async (tx) => {
    // Lock the entity row by reading it inside the transaction
    const entity = await tx.entity.findUniqueOrThrow({ where: { id } });

    // Merge properties (preserves fields not in the update)
    const updateData: Record<string, unknown> = {};
    if (changes.type) updateData.type = changes.type;
    if (changes.properties) {
      const existing = (entity.properties as object) ?? {};
      updateData.properties = { ...existing, ...changes.properties };
    }
    if (changes.status) updateData.status = changes.status;

    if (Object.keys(updateData).length > 0) {
      await tx.entity.update({ where: { id }, data: updateData });
    }

    // Get next version number atomically within the transaction
    const latestVersion = await tx.entityVersion.findFirst({
      where: { entityId: id },
      orderBy: { versionNumber: "desc" },
    });
    const nextVersion = (latestVersion?.versionNumber ?? 0) + 1;

    // Snapshot stores all properties (geometry values are inside properties)
    mergedProps = changes.properties
      ? { ...((entity.properties as object) ?? {}), ...changes.properties }
      : entity.properties;

    await tx.entityVersion.create({
      data: {
        entityId: id,
        versionNumber: nextVersion,
        snapshot: ({
          type: changes.type ?? entity.type,
          properties: mergedProps,
        }) as any,
      },
    });
  });

  // Sync PostGIS column if primaryGeometryField value changed
  if (changes.properties) {
    const ent = await prisma.entity.findUnique({ where: { id } });
    if (ent?.modelDefinitionId) {
      const allProps = (mergedProps ?? ent.properties) as Record<string, unknown>;
      const geo = await extractPrimaryGeometry(ent.modelDefinitionId, allProps);
      if (geo) {
        await setEntityGeometry(id, geo.geojson, geo.srid);
      }
    }
  }

  return await getEntityWithGeometry(id);
}
