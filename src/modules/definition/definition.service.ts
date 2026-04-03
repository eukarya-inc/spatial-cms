import prisma from "../../db/client.js";
import { BusinessError } from "../../shared/errors.js";

// ─── Model Definition ────────────────────────────────

export async function createModelDefinition(data: {
  key: string;
  name: string;
  description?: string;
  geometryType?: "NONE" | "POINT" | "LINESTRING" | "POLYGON" | "MIXED";
}) {
  return prisma.modelDefinition.create({
    data: {
      key: data.key,
      name: data.name,
      description: data.description,
      geometryType: data.geometryType ?? "NONE",
    },
    include: { fields: true },
  });
}

export async function listModelDefinitions() {
  return prisma.modelDefinition.findMany({
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
      _count: { select: { entities: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getModelDefinition(id: string) {
  return prisma.modelDefinition.findUnique({
    where: { id },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
      sourceRelations: { include: { targetModel: true } },
      targetRelations: { include: { sourceModel: true } },
    },
  });
}

export async function updateModelDefinition(
  id: string,
  data: {
    name?: string;
    description?: string;
    geometryType?: "NONE" | "POINT" | "LINESTRING" | "POLYGON" | "MIXED";
  },
) {
  return prisma.modelDefinition.update({
    where: { id },
    data,
    include: { fields: { orderBy: { orderIndex: "asc" } } },
  });
}

export async function deleteModelDefinition(id: string) {
  const model = await prisma.modelDefinition.findUnique({ where: { id } });
  if (!model) throw new BusinessError("Model not found");

  // Count affected entities for response
  const entityCount = await prisma.entity.count({ where: { modelDefinitionId: id } });

  // Cascade: disconnect proposals, delete versions, delete entities
  if (entityCount > 0) {
    await prisma.proposal.updateMany({
      where: { entity: { modelDefinitionId: id } },
      data: { entityId: null },
    });
    await prisma.entityVersion.deleteMany({
      where: { entity: { modelDefinitionId: id } },
    });
    await prisma.$executeRaw`DELETE FROM entity WHERE model_definition_id = ${id}::uuid`;
  }

  // Delete governance policies (polymorphic, no FK)
  await prisma.governancePolicy.deleteMany({ where: { targetType: "model", targetId: id } });

  // Delete bindings, fields, relations (Prisma cascade handles some)
  await prisma.datasetModelBinding.deleteMany({ where: { modelDefinitionId: id } });
  await prisma.relationDefinition.deleteMany({
    where: { OR: [{ sourceModelDefinitionId: id }, { targetModelDefinitionId: id }] },
  });
  await prisma.fieldDefinition.deleteMany({ where: { modelDefinitionId: id } });

  // Finally delete the model
  await prisma.modelDefinition.delete({ where: { id } });

  return { deleted: true, key: model.key, entitiesDeleted: entityCount };
}

// ─── Field Definition ────────────────────────────────

export async function addField(
  modelDefinitionId: string,
  data: {
    key: string;
    label: string;
    fieldType: string;
    isRequired?: boolean;
    defaultValue?: unknown;
    enumValues?: string[];
    validationJson?: object;
    orderIndex?: number;
  },
) {
  return prisma.fieldDefinition.create({
    data: {
      modelDefinitionId,
      key: data.key,
      label: data.label,
      fieldType: data.fieldType as any,
      isRequired: data.isRequired ?? false,
      defaultValue: data.defaultValue !== undefined ? (data.defaultValue as any) : undefined,
      enumValues: data.enumValues ?? undefined,
      validationJson: data.validationJson ?? undefined,
      orderIndex: data.orderIndex ?? 0,
    },
  });
}

export async function updateField(
  fieldId: string,
  data: {
    label?: string;
    fieldType?: string;
    isRequired?: boolean;
    defaultValue?: unknown;
    enumValues?: string[];
    validationJson?: object;
    orderIndex?: number;
  },
) {
  const updateData: Record<string, unknown> = {};
  if (data.label !== undefined) updateData.label = data.label;
  if (data.fieldType !== undefined) updateData.fieldType = data.fieldType;
  if (data.isRequired !== undefined) updateData.isRequired = data.isRequired;
  if (data.defaultValue !== undefined) updateData.defaultValue = data.defaultValue;
  if (data.enumValues !== undefined) updateData.enumValues = data.enumValues;
  if (data.validationJson !== undefined) updateData.validationJson = data.validationJson;
  if (data.orderIndex !== undefined) updateData.orderIndex = data.orderIndex;

  return prisma.fieldDefinition.update({
    where: { id: fieldId },
    data: updateData,
  });
}

export async function removeField(fieldId: string) {
  return prisma.fieldDefinition.delete({ where: { id: fieldId } });
}

// ─── Relation Definition ─────────────────────────────

export async function addRelation(data: {
  sourceModelDefinitionId: string;
  targetModelDefinitionId: string;
  relationType: "belongs_to" | "has_many" | "many_to_many";
  key: string;
  inverseKey?: string;
  isRequired?: boolean;
}) {
  return prisma.relationDefinition.create({
    data: {
      sourceModelDefinitionId: data.sourceModelDefinitionId,
      targetModelDefinitionId: data.targetModelDefinitionId,
      relationType: data.relationType,
      key: data.key,
      inverseKey: data.inverseKey,
      isRequired: data.isRequired ?? false,
    },
    include: { sourceModel: true, targetModel: true },
  });
}

export async function removeRelation(id: string) {
  return prisma.relationDefinition.delete({ where: { id } });
}

// ─── Model Schema (for frontend form generation) ─────

export async function getModelSchema(modelDefinitionId: string) {
  const model = await prisma.modelDefinition.findUnique({
    where: { id: modelDefinitionId },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
      sourceRelations: { include: { targetModel: true } },
    },
  });
  if (!model) return null;

  return {
    id: model.id,
    key: model.key,
    name: model.name,
    geometryType: model.geometryType,
    fields: model.fields.map((f) => ({
      key: f.key,
      label: f.label,
      fieldType: f.fieldType,
      isRequired: f.isRequired,
      defaultValue: f.defaultValue,
      enumValues: f.enumValues,
      validation: f.validationJson,
    })),
    relations: model.sourceRelations.map((r) => ({
      key: r.key,
      targetModelId: r.targetModelDefinitionId,
      targetModelKey: r.targetModel.key,
      relationType: r.relationType,
      isRequired: r.isRequired,
    })),
  };
}

// ─── Dataset Model Binding ───────────────────────────

export async function createBinding(data: {
  datasetDefinitionId: string;
  modelDefinitionId: string;
  filterJson?: object;
  projectionJson?: object;
}) {
  return prisma.datasetModelBinding.create({
    data: {
      datasetDefinitionId: data.datasetDefinitionId,
      modelDefinitionId: data.modelDefinitionId,
      filterJson: data.filterJson ?? undefined,
      projectionJson: data.projectionJson ?? undefined,
    },
    include: { modelDefinition: true },
  });
}

export async function listBindings(datasetDefinitionId: string) {
  return prisma.datasetModelBinding.findMany({
    where: { datasetDefinitionId },
    include: { modelDefinition: true },
  });
}

export async function updateBinding(id: string, data: { filterJson?: object | null; projectionJson?: object | null }) {
  return prisma.datasetModelBinding.update({
    where: { id },
    data: {
      filterJson: data.filterJson === null ? null : data.filterJson,
      projectionJson: data.projectionJson === null ? null : data.projectionJson,
    },
    include: { modelDefinition: true },
  });
}

export async function removeBinding(id: string) {
  return prisma.datasetModelBinding.delete({ where: { id } });
}

// ─── Governance Policy ───────────────────────────────

export async function upsertGovernancePolicy(data: {
  targetType: "model" | "dataset";
  targetId: string;
  requireProposal?: boolean;
  approvalMode?: "manual" | "auto";
  publishMode?: "manual" | "auto";
}) {
  // Validate that the target actually exists
  if (data.targetType === "model") {
    const model = await prisma.modelDefinition.findUnique({ where: { id: data.targetId } });
    if (!model) throw new BusinessError(`Model with id ${data.targetId} not found`);
  } else if (data.targetType === "dataset") {
    const dataset = await prisma.datasetDefinition.findUnique({ where: { id: data.targetId } });
    if (!dataset) throw new BusinessError(`Dataset with id ${data.targetId} not found`);
  }

  return prisma.governancePolicy.upsert({
    where: {
      targetType_targetId: {
        targetType: data.targetType,
        targetId: data.targetId,
      },
    },
    create: {
      targetType: data.targetType,
      targetId: data.targetId,
      requireProposal: data.requireProposal ?? true,
      approvalMode: data.approvalMode ?? "manual",
      publishMode: data.publishMode ?? "manual",
    },
    update: {
      requireProposal: data.requireProposal,
      approvalMode: data.approvalMode,
      publishMode: data.publishMode,
    },
  });
}

export async function getGovernancePolicy(
  targetType: "model" | "dataset",
  targetId: string,
) {
  return prisma.governancePolicy.findUnique({
    where: {
      targetType_targetId: { targetType, targetId },
    },
  });
}

export async function deleteGovernancePolicy(id: string) {
  return prisma.governancePolicy.delete({ where: { id } });
}
