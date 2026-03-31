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
      geometry?: { type: string; coordinates: unknown };
      status?: "draft" | "active" | "archived";
    };
  };
  source?: "human" | "machine" | "import_";
}

export async function createProposal(input: ProposalInput) {
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
    const model = await findModelDefinitionByKey(type);
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
        const result = await approveProposal(proposal.id);
        return result.proposal;
      } catch (err) {
        // Log the failure reason instead of swallowing silently
        console.warn(
          `[Auto-approval] Failed for proposal ${proposal.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return proposal;
}

export async function listProposals(filters?: { status?: string }) {
  const where: Record<string, string> = {};
  if (filters?.status) where.status = filters.status;

  return prisma.proposal.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
}

export async function getProposal(id: string) {
  return prisma.proposal.findUnique({ where: { id } });
}

export async function approveProposal(id: string) {
  const proposal = await prisma.proposal.findUnique({ where: { id } });
  if (!proposal) throw new NotFoundError("Proposal");
  if (proposal.status !== "pending")
    throw new BusinessError("Proposal is not pending");

  const change = proposal.proposedChange as {
    action: string;
    data: {
      type?: string;
      modelDefinitionId?: string;
      properties?: Record<string, unknown>;
      geometry?: { type: string; coordinates: unknown };
      status?: "draft" | "active" | "archived";
    };
  };

  // Resolve modelDefinitionId for validation
  let modelDefId = change.data.modelDefinitionId;
  if (!modelDefId && change.data.type) {
    const model = await findModelDefinitionByKey(change.data.type);
    if (model) modelDefId = model.id;
  }
  if (!modelDefId && proposal.entityId) {
    const existing = await prisma.entity.findUnique({
      where: { id: proposal.entityId },
    });
    if (existing?.modelDefinitionId) modelDefId = existing.modelDefinitionId;
  }

  // Dynamic validation against model definition
  if (modelDefId && change.data.properties) {
    const validation = await validateAgainstModel(
      modelDefId,
      change.data.properties,
      change.data.geometry ?? null,
    );
    if (!validation.valid) {
      throw new BusinessError(
        `Validation failed: ${validation.errors.join("; ")}`,
      );
    }
  }

  let entity;

  if (change.action === "create") {
    entity = await createEntityInternal({
      type: change.data.type!,
      modelDefinitionId: modelDefId,
      properties: change.data.properties,
      geometry: change.data.geometry,
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

export async function rejectProposal(id: string) {
  return prisma.proposal.update({
    where: { id },
    data: { status: "rejected" },
  });
}
