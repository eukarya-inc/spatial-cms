import prisma from "../../db/client.js";
import { getEntityWithGeometry } from "../../shared/geometry.js";

/** List all datasets that have an active published release */
export async function listPublishedDatasets() {
  const releases = await prisma.activeReleaseState.findMany({
    include: {
      datasetDefinition: true,
      activeSnapshot: true,
    },
  });

  return releases.map((r) => ({
    id: r.datasetDefinitionId,
    name: r.datasetDefinition.name,
    snapshot: {
      id: r.activeSnapshotId,
      version: r.activeSnapshot.version,
      entityCount: Array.isArray(r.activeSnapshot.manifest)
        ? r.activeSnapshot.manifest.length
        : 0,
      publishedAt: r.updatedAt,
    },
  }));
}

/** Get a specific published dataset with its active snapshot metadata */
export async function getPublishedDataset(datasetDefinitionId: string) {
  const release = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
    include: {
      datasetDefinition: true,
      activeSnapshot: true,
    },
  });

  if (!release) return null;

  const manifest = release.activeSnapshot.manifest as Array<{
    entityId: string;
    type: string;
    modelDefinitionId: string;
    versionNumber: number;
    snapshot: { properties?: object; geometry?: object } | null;
  }>;

  return {
    id: release.datasetDefinitionId,
    name: release.datasetDefinition.name,
    snapshot: {
      id: release.activeSnapshotId,
      version: release.activeSnapshot.version,
      entityCount: manifest.length,
      publishedAt: release.updatedAt,
    },
  };
}

/** Get all entities in a published dataset's active snapshot, with geometry */
export async function getPublishedEntities(datasetDefinitionId: string) {
  const release = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
    include: { activeSnapshot: true },
  });

  if (!release) return null;

  const manifest = release.activeSnapshot.manifest as Array<{
    entityId: string;
    type: string;
    modelDefinitionId: string;
    versionNumber: number;
    snapshot: { properties?: object; geometry?: object } | null;
  }>;

  // Fetch fresh geometry from entity table (primary), fall back to snapshot (stale)
  const entities = await Promise.all(
    manifest.map(async (item) => {
      let geometry = null;
      try {
        const fresh = await getEntityWithGeometry(item.entityId);
        geometry = fresh?.geometry ?? null;
      } catch (err) {
        console.warn(
          `[Delivery] Failed to fetch geometry for entity ${item.entityId}, using snapshot fallback:`,
          err instanceof Error ? err.message : err,
        );
        geometry = item.snapshot?.geometry ?? null;
      }

      return {
        id: item.entityId,
        type: item.type,
        version: item.versionNumber,
        properties: item.snapshot?.properties ?? {},
        geometry,
      };
    }),
  );

  return {
    dataset: {
      id: release.datasetDefinitionId,
      snapshotVersion: release.activeSnapshot.version,
      publishedAt: release.updatedAt,
    },
    entities,
  };
}
