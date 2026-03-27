import prisma from "../../db/client.js";

/** Publish a snapshot: mark as published, update active release state */
export async function publishSnapshot(datasetSnapshotId: string) {
  const snapshot = await prisma.datasetSnapshot.findUnique({
    where: { id: datasetSnapshotId },
  });
  if (!snapshot) throw new Error("Snapshot not found");
  if (snapshot.status !== "ready")
    throw new Error("Snapshot must be in 'ready' status to publish");

  // Mark snapshot as published
  await prisma.datasetSnapshot.update({
    where: { id: datasetSnapshotId },
    data: { status: "published" },
  });

  // Upsert active release state
  await prisma.activeReleaseState.upsert({
    where: { datasetDefinitionId: snapshot.datasetDefinitionId },
    create: {
      datasetDefinitionId: snapshot.datasetDefinitionId,
      activeSnapshotId: datasetSnapshotId,
    },
    update: {
      activeSnapshotId: datasetSnapshotId,
    },
  });

  // Record publication
  const publication = await prisma.publication.create({
    data: {
      datasetSnapshotId,
      type: "publish",
      status: "completed",
    },
  });

  return publication;
}

/** Rollback: switch active release to a previous snapshot */
export async function rollback(datasetDefinitionId: string) {
  const activeRelease = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
  });
  if (!activeRelease) throw new Error("No active release to rollback");

  // Find the previous published snapshot
  const previousSnapshot = await prisma.datasetSnapshot.findFirst({
    where: {
      datasetDefinitionId,
      status: "published",
      id: { not: activeRelease.activeSnapshotId },
    },
    orderBy: { version: "desc" },
  });
  if (!previousSnapshot) throw new Error("No previous snapshot to rollback to");

  // Update active release
  await prisma.activeReleaseState.update({
    where: { datasetDefinitionId },
    data: { activeSnapshotId: previousSnapshot.id },
  });

  // Record rollback
  const publication = await prisma.publication.create({
    data: {
      datasetSnapshotId: previousSnapshot.id,
      type: "rollback",
      status: "completed",
    },
  });

  return { publication, rolledBackTo: previousSnapshot };
}

export async function listPublications() {
  return prisma.publication.findMany({
    include: { datasetSnapshot: true },
    orderBy: { createdAt: "desc" },
  });
}
