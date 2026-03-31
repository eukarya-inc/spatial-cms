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

  // Build manifest
  const manifest = entities.map((e) => ({
    entityId: e.id,
    type: e.type,
    modelDefinitionId: e.modelDefinitionId,
    versionNumber: e.versions[0]?.versionNumber ?? 0,
    snapshot: e.versions[0]?.snapshot ?? null,
  }));

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
