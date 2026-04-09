import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Clean all business data from the database (preserves schema) */
export async function cleanDatabase() {
  await prisma.apiKey.deleteMany();
  await prisma.activeReleaseState.deleteMany();
  await prisma.publication.deleteMany();
  await prisma.datasetSnapshot.deleteMany();
  await prisma.datasetModelBinding.deleteMany();
  await prisma.datasetDefinition.deleteMany();
  await prisma.governancePolicy.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.entityVersion.deleteMany();
  await prisma.$executeRaw`DELETE FROM entity`;
  await prisma.fieldDefinition.deleteMany();
  await prisma.modelDefinition.deleteMany();
}

/** Create a building model with fields for testing (unique key per call) */
export async function createTestModel() {
  const suffix = Math.random().toString(36).substring(2, 8);
  const model = await prisma.modelDefinition.create({
    data: {
      key: `test_building_${suffix}`,
      name: "Test Building",
      primaryGeometryField: "location",
    },
  });

  await prisma.fieldDefinition.createMany({
    data: [
      {
        modelDefinitionId: model.id,
        key: "location",
        label: "Location",
        fieldType: "geometry",
        geometryType: "POINT",
        geometrySrid: 4326,
        isRequired: false,
        orderIndex: -1,
      },
      {
        modelDefinitionId: model.id,
        key: "name",
        label: "Name",
        fieldType: "string",
        isRequired: true,
        orderIndex: 0,
      },
      {
        modelDefinitionId: model.id,
        key: "height",
        label: "Height",
        fieldType: "number",
        isRequired: false,
        orderIndex: 1,
      },
    ],
  });

  return model;
}

/** Create an auto-approval governance policy for a model */
export async function setAutoApproval(modelId: string) {
  return prisma.governancePolicy.create({
    data: {
      targetType: "model",
      targetId: modelId,
      approvalMode: "auto",
      publishMode: "manual",
    },
  });
}

export { prisma };
