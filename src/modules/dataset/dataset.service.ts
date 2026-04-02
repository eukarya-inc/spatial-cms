import prisma from "../../db/client.js";
import { NotFoundError, BusinessError } from "../../shared/errors.js";

export async function listDatasetDefinitions() {
  return prisma.datasetDefinition.findMany({
    include: { activeReleaseState: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getDatasetDefinition(id: string) {
  return prisma.datasetDefinition.findUnique({
    where: { id },
    include: { snapshots: { orderBy: { version: "desc" } } },
  });
}

export async function createDatasetDefinition(data: {
  name: string;
  entityTypes?: string[];
  filterRule?: object;
  projectionRule?: object;
  primaryGeometryRule?: object;
}) {
  return prisma.datasetDefinition.create({
    data: {
      name: data.name,
      entityTypes: data.entityTypes ?? [],
      filterRule: data.filterRule ?? undefined,
      projectionRule: data.projectionRule ?? undefined,
      primaryGeometryRule: data.primaryGeometryRule ?? undefined,
    },
  });
}

export async function updateDatasetDefinition(id: string, data: { name?: string; publishToDelivery?: boolean; publishToOgc?: boolean }) {
  const dataset = await prisma.datasetDefinition.findUnique({ where: { id } });
  if (!dataset) throw new NotFoundError("Dataset definition");
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.publishToDelivery !== undefined) updateData.publishToDelivery = data.publishToDelivery;
  if (data.publishToOgc !== undefined) updateData.publishToOgc = data.publishToOgc;
  return prisma.datasetDefinition.update({ where: { id }, data: updateData });
}

export async function deleteDatasetDefinition(id: string) {
  const dataset = await prisma.datasetDefinition.findUnique({ where: { id } });
  if (!dataset) throw new NotFoundError("Dataset definition");

  // Cascade: ActiveReleaseState, Publications, Snapshots, Bindings, GovernancePolicy
  // Prisma schema has onDelete: Cascade for most relations.
  // ActiveReleaseState needs manual delete (it references snapshot with onDelete: Restrict)
  await prisma.activeReleaseState.deleteMany({ where: { datasetDefinitionId: id } });
  // GovernancePolicy is polymorphic (no FK), delete manually
  await prisma.governancePolicy.deleteMany({ where: { targetType: "dataset", targetId: id } });

  return prisma.datasetDefinition.delete({ where: { id } });
}

/** Generate a snapshot: select entities matching the definition, build manifest */
export async function generateSnapshot(datasetDefinitionId: string) {
  const definition = await prisma.datasetDefinition.findUnique({
    where: { id: datasetDefinitionId },
  });
  if (!definition) throw new NotFoundError("Dataset definition");

  // Check for model bindings (new path)
  const bindings = await prisma.datasetModelBinding.findMany({
    where: { datasetDefinitionId },
    include: { modelDefinition: true },
  });

  let entities;

  if (bindings.length > 0) {
    // New path: query entities by model bindings
    const modelDefIds = bindings.map((b) => b.modelDefinitionId);
    entities = await prisma.entity.findMany({
      where: {
        modelDefinitionId: { in: modelDefIds },
        status: "active",
      },
      include: {
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
      },
    });
  } else {
    // Legacy path: query by entityTypes array
    const entityTypes = (definition.entityTypes as string[] | null) ?? [];
    if (!entityTypes.length) {
      throw new BusinessError("Dataset has no model bindings and no entity types configured");
    }
    entities = await prisma.entity.findMany({
      where: {
        type: { in: entityTypes },
        status: "active",
      },
      include: {
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
      },
    });
  }

  // Build projection map: modelDefinitionId → projectionJson
  const projectionMap: Record<string, { mode: string; fields: string[] } | null> = {};
  bindings.forEach((b) => {
    projectionMap[b.modelDefinitionId] = b.projectionJson as { mode: string; fields: string[] } | null;
  });

  // Build manifest with field projection applied
  const manifest = entities.map((e) => {
    const snapshot = e.versions[0]?.snapshot as Record<string, unknown> | null;
    let filteredSnapshot = snapshot;

    if (snapshot && e.modelDefinitionId) {
      const projection = projectionMap[e.modelDefinitionId];
      if (projection?.fields?.length) {
        const props = (snapshot.properties ?? {}) as Record<string, unknown>;
        let filteredProps: Record<string, unknown>;
        if (projection.mode === "include") {
          filteredProps = {};
          projection.fields.forEach((f) => { if (f in props) filteredProps[f] = props[f]; });
        } else {
          filteredProps = { ...props };
          projection.fields.forEach((f) => { delete filteredProps[f]; });
        }
        filteredSnapshot = { ...snapshot, properties: filteredProps };
      }
    }

    return {
      entityId: e.id,
      type: e.type,
      modelDefinitionId: e.modelDefinitionId,
      versionNumber: e.versions[0]?.versionNumber ?? 0,
      snapshot: filteredSnapshot,
    };
  });

  // Next version number
  const latestSnapshot = await prisma.datasetSnapshot.findFirst({
    where: { datasetDefinitionId },
    orderBy: { version: "desc" },
  });
  const nextVersion = (latestSnapshot?.version ?? 0) + 1;

  return prisma.datasetSnapshot.create({
    data: {
      datasetDefinitionId,
      version: nextVersion,
      manifest,
      status: "ready",
    },
  });
}
