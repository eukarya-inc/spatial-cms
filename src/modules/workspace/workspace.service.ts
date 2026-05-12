import prisma from "../../db/client.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

export async function listWorkspaces() {
  return prisma.workspace.findMany({ orderBy: [{ slug: "asc" }] });
}

export async function getWorkspaceBySlug(slug: string) {
  const ws = await prisma.workspace.findUnique({ where: { slug } });
  if (!ws) throw new NotFoundError(`Workspace '${slug}'`);
  return ws;
}

export async function createWorkspace(data: { slug: string; name: string; description?: string }) {
  const existing = await prisma.workspace.findUnique({ where: { slug: data.slug } });
  if (existing) throw new BusinessError(`Workspace '${data.slug}' already exists`);
  return prisma.workspace.create({ data });
}

/**
 * Cascade-delete a workspace and ALL its contents:
 * models, fields, datasets, snapshots, publications, bindings, governance
 * policies, proposals, entities (+ versions + geometry). For MVP/test
 * convenience. Cannot be undone.
 */
export async function deleteWorkspace(slug: string) {
  if (slug === "default") throw new BusinessError("Cannot delete the default workspace");
  const ws = await prisma.workspace.findUnique({ where: { slug } });
  if (!ws) throw new NotFoundError(`Workspace '${slug}'`);

  await prisma.$transaction(async (tx) => {
    const modelIds = (
      await tx.modelDefinition.findMany({ where: { workspaceId: ws.id }, select: { id: true } })
    ).map((m) => m.id);
    const datasetIds = (
      await tx.datasetDefinition.findMany({ where: { workspaceId: ws.id }, select: { id: true } })
    ).map((d) => d.id);

    // ActiveReleaseState references snapshot with onDelete: Restrict — must go first.
    if (datasetIds.length) {
      await tx.activeReleaseState.deleteMany({
        where: { datasetDefinitionId: { in: datasetIds } },
      });
    }

    // GovernancePolicy is polymorphic — no FK, manual delete.
    if (modelIds.length || datasetIds.length) {
      await tx.governancePolicy.deleteMany({
        where: {
          OR: [
            { targetType: "model", targetId: { in: modelIds } },
            { targetType: "dataset", targetId: { in: datasetIds } },
          ],
        },
      });
    }

    // Proposals attached to in-workspace entities — wipe them entirely (audit trail
    // for a deleted workspace isn't worth keeping in MVP).
    if (modelIds.length) {
      await tx.proposal.deleteMany({
        where: { entity: { modelDefinitionId: { in: modelIds } } },
      });
    }

    // Entities — raw SQL because of PostGIS Unsupported geometry column.
    // EntityVersion + EntityGeometry cascade via Entity's FK.
    if (modelIds.length) {
      await tx.$executeRaw`DELETE FROM entity WHERE model_definition_id = ANY(${modelIds}::uuid[])`;
    }

    // Datasets first (cascades DatasetSnapshot → Publication, DatasetModelBinding).
    if (datasetIds.length) {
      await tx.datasetDefinition.deleteMany({ where: { workspaceId: ws.id } });
    }
    // Then models (cascades FieldDefinition + remaining DatasetModelBinding from model side).
    if (modelIds.length) {
      await tx.modelDefinition.deleteMany({ where: { workspaceId: ws.id } });
    }

    await tx.workspace.delete({ where: { id: ws.id } });
  });
}

// ─── Locate ───────────────────────────────────────────
// Cross-workspace lookups so a 404 in the current workspace can offer
// "this record lives in workspace X, switch?" instead of a dead page.

export async function locateEntity(id: string) {
  const e = await prisma.entity.findUnique({
    where: { id },
    include: { modelDefinition: { include: { workspace: true } } },
  });
  return e?.modelDefinition?.workspace ?? null;
}

export async function locateModel(id: string) {
  const m = await prisma.modelDefinition.findUnique({
    where: { id },
    include: { workspace: true },
  });
  return m?.workspace ?? null;
}

export async function locateDataset(id: string) {
  const d = await prisma.datasetDefinition.findUnique({
    where: { id },
    include: { workspace: true },
  });
  return d?.workspace ?? null;
}
