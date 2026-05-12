import prisma from "../../db/client.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

/** Verify snapshot's dataset is in the workspace. Throws NotFoundError otherwise. */
async function assertSnapshotInWorkspace(workspaceId: string, snapshotId: string) {
  const snap = await prisma.datasetSnapshot.findUnique({
    where: { id: snapshotId },
    include: { datasetDefinition: { select: { workspaceId: true } } },
  });
  if (!snap || snap.datasetDefinition.workspaceId !== workspaceId) {
    throw new NotFoundError("Snapshot");
  }
  return snap;
}

/** Publish a snapshot: mark as published, update active release state */
export async function publishSnapshot(workspaceId: string, datasetSnapshotId: string) {
  const snapshot = await assertSnapshotInWorkspace(workspaceId, datasetSnapshotId);
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
export async function rollback(workspaceId: string, datasetDefinitionId: string) {
  // Verify dataset is in workspace
  const ds = await prisma.datasetDefinition.findFirst({
    where: { id: datasetDefinitionId, workspaceId },
  });
  if (!ds) throw new NotFoundError("Dataset definition");

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
export async function triggerPublishHook(workspaceId: string, datasetSnapshotId: string) {
  const snapshot = await prisma.datasetSnapshot.findUnique({
    where: { id: datasetSnapshotId },
    include: { datasetDefinition: true },
  });
  if (!snapshot || snapshot.datasetDefinition.workspaceId !== workspaceId) {
    throw new NotFoundError("Snapshot");
  }

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

export async function listPublications(workspaceId: string) {
  return prisma.publication.findMany({
    where: { datasetSnapshot: { datasetDefinition: { workspaceId } } },
    include: { datasetSnapshot: true },
    orderBy: { createdAt: "desc" },
  });
}
