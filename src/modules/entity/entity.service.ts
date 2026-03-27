import prisma from "../../db/client.js";
import {
  getEntityWithGeometry,
  setEntityGeometry,
} from "../../shared/geometry.js";

export async function listEntities(filters?: {
  type?: string;
  status?: string;
}) {
  const where: Record<string, string> = {};
  if (filters?.type) where.type = filters.type;
  if (filters?.status) where.status = filters.status;

  return prisma.entity.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
}

export async function getEntity(id: string) {
  return getEntityWithGeometry(id);
}

// Direct entity creation is intentionally NOT exposed.
// Entities are created/modified through the proposal system.
// This helper is used internally by the proposal approval flow.
export async function createEntityInternal(data: {
  type: string;
  properties?: Record<string, unknown>;
  geometry?: { type: string; coordinates: unknown };
}) {
  const entity = await prisma.entity.create({
    data: {
      type: data.type,
      properties: data.properties ?? {},
      status: "draft",
    },
  });

  if (data.geometry) {
    await setEntityGeometry(entity.id, data.geometry);
  }

  // Create initial version
  await prisma.entityVersion.create({
    data: {
      entityId: entity.id,
      versionNumber: 1,
      snapshot: {
        type: data.type,
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
  // Get current version number
  const latestVersion = await prisma.entityVersion.findFirst({
    where: { entityId: id },
    orderBy: { versionNumber: "desc" },
  });
  const nextVersion = (latestVersion?.versionNumber ?? 0) + 1;

  // Update entity fields (excluding geometry)
  const updateData: Record<string, unknown> = {};
  if (changes.type) updateData.type = changes.type;
  if (changes.properties) updateData.properties = changes.properties;
  if (changes.status) updateData.status = changes.status;

  if (Object.keys(updateData).length > 0) {
    await prisma.entity.update({ where: { id }, data: updateData });
  }

  if (changes.geometry) {
    await setEntityGeometry(id, changes.geometry);
  }

  // Create new version snapshot
  const current = await getEntityWithGeometry(id);
  await prisma.entityVersion.create({
    data: {
      entityId: id,
      versionNumber: nextVersion,
      snapshot: {
        type: current?.type,
        properties: current?.properties,
        geometry: current?.geometry,
      },
    },
  });

  return current;
}
