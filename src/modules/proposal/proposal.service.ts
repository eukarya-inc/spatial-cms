import prisma from "../../db/client.js";
import {
  createEntityInternal,
  updateEntityInternal,
} from "../entity/entity.service.js";
import {
  validateAgainstModel,
  findModelDefinitionByKey,
} from "../../shared/dynamic-validation.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

interface ProposalInput {
  entityId?: string;
  proposedChange: {
    action: "create" | "update" | "delete";
    data: {
      type?: string;
      modelDefinitionId?: string;
      properties?: Record<string, unknown>;
      status?: "draft" | "active" | "archived";
    };
  };
  source?: "human" | "machine" | "import_";
}

/** Verifies proposal is in workspace (via its entity's model). Throws NotFoundError otherwise. */
async function assertProposalInWorkspace(workspaceId: string, id: string) {
  const proposal = await prisma.proposal.findUnique({
    where: { id },
    include: { entity: { include: { modelDefinition: { select: { workspaceId: true } } } } },
  });
  if (!proposal) throw new NotFoundError("Proposal");
  // For proposals with no entityId (e.g. create), workspace ownership is implicit via
  // the resolved model.key — we'll validate it inside approveProposal. For now allow.
  if (proposal.entityId && proposal.entity?.modelDefinition?.workspaceId !== workspaceId) {
    throw new NotFoundError("Proposal");
  }
  return proposal;
}

export async function createProposal(workspaceId: string, input: ProposalInput) {
  // For update/delete proposals, resolve entity type if not provided + verify ownership
  if (input.entityId && !input.proposedChange.data.type) {
    const entity = await prisma.entity.findUnique({
      where: { id: input.entityId },
      include: { modelDefinition: { select: { workspaceId: true, key: true } } },
    });
    if (entity?.modelDefinition?.workspaceId !== workspaceId) {
      throw new NotFoundError("Entity");
    }
    if (entity.modelDefinition.key) input.proposedChange.data.type = entity.modelDefinition.key;
  } else if (input.entityId) {
    // entityId provided + type provided — still verify ownership
    const entity = await prisma.entity.findUnique({
      where: { id: input.entityId },
      include: { modelDefinition: { select: { workspaceId: true } } },
    });
    if (!entity || entity.modelDefinition?.workspaceId !== workspaceId) {
      throw new NotFoundError("Entity");
    }
  }

  // For create proposals, verify the named type exists in this workspace
  if (!input.entityId && input.proposedChange.data.type) {
    const model = await findModelDefinitionByKey(workspaceId, input.proposedChange.data.type);
    if (!model) {
      throw new BusinessError(`Model "${input.proposedChange.data.type}" not found in this workspace`);
    }
    input.proposedChange.data.modelDefinitionId = model.id;
  }

  const proposal = await prisma.proposal.create({
    data: {
      entityId: input.entityId,
      proposedChange: input.proposedChange as object,
      source: input.source ?? "human",
      status: "pending",
    },
  });

  // Check for auto-approval governance policy
  const type = input.proposedChange.data.type;
  const modelDefId = input.proposedChange.data.modelDefinitionId;
  let resolvedModelId = modelDefId;
  if (!resolvedModelId && type) {
    const model = await findModelDefinitionByKey(workspaceId, type);
    if (model) resolvedModelId = model.id;
  }
  if (!resolvedModelId && input.entityId) {
    const entity = await prisma.entity.findUnique({ where: { id: input.entityId } });
    if (entity?.modelDefinitionId) resolvedModelId = entity.modelDefinitionId;
  }

  if (resolvedModelId) {
    const policy = await prisma.governancePolicy.findUnique({
      where: {
        targetType_targetId: { targetType: "model", targetId: resolvedModelId },
      },
    });
    if (policy?.approvalMode === "auto") {
      try {
        const result = await approveProposal(workspaceId, proposal.id);
        return result.proposal;
      } catch (err) {
        console.warn(
          `[Auto-approval] Failed for proposal ${proposal.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return proposal;
}

export async function listProposals(workspaceId: string, filters?: { status?: string }) {
  const where: Record<string, unknown> = {
    OR: [
      // Proposals attached to entities — entity's model must be in workspace
      { entity: { modelDefinition: { workspaceId } } },
      // Create proposals (no entityId yet) — match by resolved model.key
      {
        entityId: null,
        // Match the proposed type to a model in the workspace
        // Prisma doesn't support nested JSON field filters easily, so post-filter
      },
    ],
  };
  if (filters?.status) where.status = filters.status;

  const result = await prisma.proposal.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  // Post-filter create proposals against the workspace's models by .key
  const wsModels = await prisma.modelDefinition.findMany({
    where: { workspaceId },
    select: { key: true },
  });
  const wsKeys = new Set(wsModels.map((m) => m.key));
  return result.filter((p) => {
    if (p.entityId) return true; // already filtered by relation
    const change = p.proposedChange as { data?: { type?: string } };
    return change?.data?.type ? wsKeys.has(change.data.type) : false;
  });
}

export async function getProposal(workspaceId: string, id: string) {
  return assertProposalInWorkspace(workspaceId, id);
}

export async function approveProposal(workspaceId: string, id: string) {
  const proposal = await assertProposalInWorkspace(workspaceId, id);
  if (proposal.status !== "pending")
    throw new BusinessError("Proposal is not pending");

  const change = proposal.proposedChange as {
    action: string;
    data: {
      type?: string;
      modelDefinitionId?: string;
      properties?: Record<string, unknown>;
      status?: "draft" | "active" | "archived";
    };
  };

  // Resolve modelDefinitionId for validation, scoped to workspace
  let modelDefId = change.data.modelDefinitionId;
  if (!modelDefId && change.data.type) {
    const model = await findModelDefinitionByKey(workspaceId, change.data.type);
    if (model) modelDefId = model.id;
  }
  if (!modelDefId && proposal.entityId) {
    const existing = await prisma.entity.findUnique({
      where: { id: proposal.entityId },
    });
    if (existing?.modelDefinitionId) modelDefId = existing.modelDefinitionId;
  }

  if (modelDefId && change.data.properties && change.action === "create") {
    const validation = await validateAgainstModel(
      modelDefId,
      change.data.properties,
    );
    if (!validation.valid) {
      throw new BusinessError(
        `Validation failed: ${validation.errors.join("; ")}`,
      );
    }
  }

  let entity;

  if (change.action === "create") {
    entity = await createEntityInternal(workspaceId, {
      type: change.data.type!,
      modelDefinitionId: modelDefId,
      properties: change.data.properties,
    });
  } else if (change.action === "update") {
    if (!proposal.entityId) throw new BusinessError("entityId required for update");
    entity = await updateEntityInternal(proposal.entityId, change.data);
  } else if (change.action === "delete") {
    if (!proposal.entityId) throw new BusinessError("entityId required for delete");
    entity = await updateEntityInternal(proposal.entityId, {
      status: "archived",
    });
  } else {
    throw new BusinessError(`Unknown action: ${change.action}`);
  }

  await prisma.proposal.update({
    where: { id },
    data: { status: "approved" },
  });

  return { proposal: { ...proposal, status: "approved" }, entity };
}

/**
 * Batch approve: approve multiple pending proposals in this workspace.
 */
export async function approveBatch(
  workspaceId: string,
  ids?: string[],
  filter?: { type?: string },
) {
  // Reuse listProposals's workspace scoping for the "all" path
  const wsProposals = await listProposals(workspaceId, { status: "pending" });

  let proposals = wsProposals;
  if (ids?.length) {
    const idSet = new Set(ids);
    proposals = wsProposals.filter((p) => idSet.has(p.id));
  } else if (filter?.type) {
    proposals = wsProposals.filter((p) => {
      const change = p.proposedChange as { data?: { type?: string } };
      return change.data?.type === filter.type;
    });
  }

  let approved = 0;
  let failed = 0;
  const errors: Array<{ proposalId: string; error: string }> = [];

  for (const p of proposals) {
    try {
      await approveProposal(workspaceId, p.id);
      approved++;
    } catch (err) {
      failed++;
      errors.push({
        proposalId: p.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { total: proposals.length, approved, failed, errors };
}

export async function rejectProposal(workspaceId: string, id: string) {
  await assertProposalInWorkspace(workspaceId, id);
  return prisma.proposal.update({
    where: { id },
    data: { status: "rejected" },
  });
}
