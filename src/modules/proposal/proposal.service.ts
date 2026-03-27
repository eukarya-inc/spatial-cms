import prisma from "../../db/client.js";
import {
  createEntityInternal,
  updateEntityInternal,
} from "../entity/entity.service.js";

interface ProposalInput {
  entityId?: string;
  proposedChange: {
    action: "create" | "update";
    data: {
      type?: string;
      properties?: Record<string, unknown>;
      geometry?: { type: string; coordinates: unknown };
      status?: "draft" | "active" | "archived";
    };
  };
  source?: "human" | "machine" | "import_";
}

export async function createProposal(input: ProposalInput) {
  return prisma.proposal.create({
    data: {
      entityId: input.entityId,
      proposedChange: input.proposedChange as object,
      source: input.source ?? "human",
      status: "pending",
    },
  });
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
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "pending")
    throw new Error("Proposal is not pending");

  const change = proposal.proposedChange as {
    action: string;
    data: {
      type?: string;
      properties?: Record<string, unknown>;
      geometry?: { type: string; coordinates: unknown };
      status?: "draft" | "active" | "archived";
    };
  };

  let entity;

  if (change.action === "create") {
    entity = await createEntityInternal({
      type: change.data.type!,
      properties: change.data.properties,
      geometry: change.data.geometry,
    });
  } else if (change.action === "update") {
    if (!proposal.entityId) throw new Error("entityId required for update");
    entity = await updateEntityInternal(proposal.entityId, change.data);
  } else {
    throw new Error(`Unknown action: ${change.action}`);
  }

  // Mark proposal as approved
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
