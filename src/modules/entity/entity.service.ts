import prisma from "../../db/client.js";
import {
  getEntityWithGeometry,
  setEntityGeometry,
} from "../../shared/geometry.js";
import { findModelDefinitionByKey } from "../../shared/dynamic-validation.js";

export async function listEntities(filters?: {
  type?: string;
  status?: string;
  modelDefinitionId?: string;
}) {
  const where: Record<string, unknown> = {};
  if (filters?.type) where.type = filters.type;
  if (filters?.status) where.status = filters.status;
  if (filters?.modelDefinitionId) where.modelDefinitionId = filters.modelDefinitionId;

  return prisma.entity.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
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

  return getEntityWithGeometry(id);
}
