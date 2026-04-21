import prisma from "../../db/client.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

/** Publish a snapshot: mark as published, update active release state */
export async function publishSnapshot(datasetSnapshotId: string) {
  const snapshot = await prisma.datasetSnapshot.findUnique({
    where: { id: datasetSnapshotId },
  });
  if (!snapshot) throw new NotFoundError("Snapshot");
  if (snapshot.status !== "ready")
    throw new BusinessError("Snapshot must be in 'ready' status to publish");

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
  if (!activeRelease) throw new BusinessError("No active release to rollback");

  // Find the previous published snapshot
  const previousSnapshot = await prisma.datasetSnapshot.findFirst({
    where: {
      datasetDefinitionId,
      status: "published",
      id: { not: activeRelease.activeSnapshotId },
    },
    orderBy: { version: "desc" },
  });
  if (!previousSnapshot) throw new BusinessError("No previous snapshot to rollback to");

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

/**
 * Publish hook: simulates sending publication event to a Serve layer.
 * In production this would call an external service or message queue.
 */
export async function triggerPublishHook(datasetSnapshotId: string) {
  const snapshot = await prisma.datasetSnapshot.findUnique({
    where: { id: datasetSnapshotId },
    include: { datasetDefinition: true },
  });
  if (!snapshot) throw new NotFoundError("Snapshot");

  const payload = {
    event: "publish",
    timestamp: new Date().toISOString(),
    datasetDefinition: {
      id: snapshot.datasetDefinition.id,
      name: snapshot.datasetDefinition.name,
    },
    snapshot: {
      id: snapshot.id,
      version: snapshot.version,
      status: snapshot.status,
      entityCount: Array.isArray(snapshot.manifest)
        ? snapshot.manifest.length
        : 0,
    },
  };

  // Simulate sending to Serve (log payload only when DEBUG is set)
  if (process.env.DEBUG) {
    console.log("[PublishHook] Sending to Serve:", JSON.stringify(payload));
  }

  return { sent: true, payload };
}

export async function listPublications() {
  return prisma.publication.findMany({
    include: { datasetSnapshot: true },
    orderBy: { createdAt: "desc" },
  });
}
