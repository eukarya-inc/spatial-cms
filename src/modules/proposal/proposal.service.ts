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

/** Verifies proposal is in workspace via its direct workspaceId FK. */
async function assertProposalInWorkspace(workspaceId: string, id: string) {
  const proposal = await prisma.proposal.findFirst({ where: { id, workspaceId } });
  if (!proposal) throw new NotFoundError("Proposal");
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
      workspaceId,
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
  return prisma.proposal.findMany({
    where: { workspaceId, ...(filters?.status ? { status: filters.status as any } : {}) },
    orderBy: { createdAt: "desc" },
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
