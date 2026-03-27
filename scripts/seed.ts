import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // --- Create proposals for new entities ---

  const proposal1 = await prisma.proposal.create({
    data: {
      proposedChange: {
        action: "create",
        data: {
          type: "building",
          properties: {
            name: "Tokyo Tower",
            height: 333,
            yearBuilt: 1958,
          },
          geometry: {
            type: "Point",
            coordinates: [139.7454, 35.6586],
          },
        },
      },
      source: "human",
      status: "pending",
    },
  });
  console.log(`Created proposal: ${proposal1.id}`);

  const proposal2 = await prisma.proposal.create({
    data: {
      proposedChange: {
        action: "create",
        data: {
          type: "building",
          properties: {
            name: "Osaka Castle",
            height: 55,
            yearBuilt: 1931,
          },
          geometry: {
            type: "Point",
            coordinates: [135.5256, 34.6873],
          },
        },
      },
      source: "human",
      status: "pending",
    },
  });
  console.log(`Created proposal: ${proposal2.id}`);

  const proposal3 = await prisma.proposal.create({
    data: {
      proposedChange: {
        action: "create",
        data: {
          type: "park",
          properties: {
            name: "Ueno Park",
            area_sqm: 538000,
          },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [139.7692, 35.7146],
                [139.7752, 35.7146],
                [139.7752, 35.7186],
                [139.7692, 35.7186],
                [139.7692, 35.7146],
              ],
            ],
          },
        },
      },
      source: "import_",
      status: "pending",
    },
  });
  console.log(`Created proposal: ${proposal3.id}`);

  // --- Simulate approving proposals (create entities via internal flow) ---

  // Approve proposal1: create Tokyo Tower entity
  const entity1 = await prisma.entity.create({
    data: {
      type: "building",
      properties: { name: "Tokyo Tower", height: 333, yearBuilt: 1958 },
      status: "active",
    },
  });
  await prisma.$executeRaw`
    UPDATE entity SET geometry = ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[139.7454,35.6586]}'), 4326)
    WHERE id = ${entity1.id}::uuid
  `;
  await prisma.entityVersion.create({
    data: {
      entityId: entity1.id,
      versionNumber: 1,
      snapshot: {
        type: "building",
        properties: { name: "Tokyo Tower", height: 333, yearBuilt: 1958 },
        geometry: { type: "Point", coordinates: [139.7454, 35.6586] },
      },
    },
  });
  await prisma.proposal.update({
    where: { id: proposal1.id },
    data: { status: "approved", entityId: entity1.id },
  });
  console.log(`Entity created (approved): ${entity1.id} — Tokyo Tower`);

  // Approve proposal2: create Osaka Castle entity
  const entity2 = await prisma.entity.create({
    data: {
      type: "building",
      properties: { name: "Osaka Castle", height: 55, yearBuilt: 1931 },
      status: "active",
    },
  });
  await prisma.$executeRaw`
    UPDATE entity SET geometry = ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[135.5256,34.6873]}'), 4326)
    WHERE id = ${entity2.id}::uuid
  `;
  await prisma.entityVersion.create({
    data: {
      entityId: entity2.id,
      versionNumber: 1,
      snapshot: {
        type: "building",
        properties: { name: "Osaka Castle", height: 55, yearBuilt: 1931 },
        geometry: { type: "Point", coordinates: [135.5256, 34.6873] },
      },
    },
  });
  await prisma.proposal.update({
    where: { id: proposal2.id },
    data: { status: "approved", entityId: entity2.id },
  });
  console.log(`Entity created (approved): ${entity2.id} — Osaka Castle`);

  // Leave proposal3 as pending (for testing the approval flow)

  // --- Create a dataset definition ---

  const dataset = await prisma.datasetDefinition.create({
    data: {
      name: "Buildings",
      entityTypes: ["building"],
      filterRule: { status: "active" },
      projectionRule: { include: ["name", "height", "yearBuilt"] },
    },
  });
  console.log(`Dataset definition created: ${dataset.id} — ${dataset.name}`);

  console.log("\nSeed complete!");
  console.log("- 3 proposals (2 approved, 1 pending)");
  console.log("- 2 entities with geometry (Tokyo Tower, Osaka Castle)");
  console.log("- 1 dataset definition (Buildings)");
  console.log(
    "\nTry: POST /api/v1/proposals/:id/approve with the pending proposal",
  );
  console.log(
    "Try: POST /api/v1/datasets/:id/snapshot to generate a snapshot",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
