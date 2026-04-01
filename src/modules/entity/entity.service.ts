import prisma from "../../db/client.js";
import {
  getEntityWithGeometry,
  setEntityGeometry,
  findEntitiesInBBox,
  findEntitiesNearPoint,
} from "../../shared/geometry.js";
import { findModelDefinitionByKey } from "../../shared/dynamic-validation.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

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

  // Spatial filtering: get matching IDs first
  if (options.bbox || options.near) {
    let spatialIds: string[];
    if (options.bbox) {
      spatialIds = await findEntitiesInBBox(options.bbox);
    } else {
      spatialIds = await findEntitiesNearPoint(
        options.near!.lon,
        options.near!.lat,
        options.near!.radius,
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
  const pageSize = Math.min(Math.max(options.pageSize || 100, 1), 1000);
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
  geometry?: { type: string; coordinates: unknown };
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
      properties: data.properties ?? {},
      status: data.status ?? "active",
    },
  });

  if (data.geometry) {
    await setEntityGeometry(entity.id, data.geometry);
  }

  await prisma.entityVersion.create({
    data: {
      entityId: entity.id,
      versionNumber: 1,
      snapshot: {
        type,
        modelDefinitionId: modelDefId ?? null,
        properties: data.properties ?? {},
        geometry: data.geometry ?? null,
      },
    },
  });

  return getEntityWithGeometry(entity.id);
}

export async function updateEntityInternal(
  id: string,
  changes: {
    type?: string;
    properties?: Record<string, unknown>;
    geometry?: { type: string; coordinates: unknown };
    status?: "draft" | "active" | "archived";
  },
) {
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

    // Create version snapshot (geometry fetched after update)
    const mergedProps = changes.properties
      ? { ...((entity.properties as object) ?? {}), ...changes.properties }
      : entity.properties;

    await tx.entityVersion.create({
      data: {
        entityId: id,
        versionNumber: nextVersion,
        snapshot: {
          type: changes.type ?? entity.type,
          properties: mergedProps,
          geometry: changes.geometry ?? null,
        },
      },
    });
  });

  // Geometry update is outside transaction (raw SQL via PostGIS)
  if (changes.geometry) {
    await setEntityGeometry(id, changes.geometry);
  }

  // Patch the version snapshot with actual geometry from PostGIS
  // (inside the transaction, geometry wasn't available via raw SQL)
  const current = await getEntityWithGeometry(id);
  if (current?.geometry) {
    const latestVer = await prisma.entityVersion.findFirst({
      where: { entityId: id },
      orderBy: { versionNumber: "desc" },
    });
    if (latestVer) {
      const snap = (latestVer.snapshot as Record<string, unknown>) ?? {};
      await prisma.entityVersion.update({
        where: { id: latestVer.id },
        data: { snapshot: { ...snap, geometry: current.geometry } },
      });
    }
  }

  return current ?? await getEntityWithGeometry(id);
}
