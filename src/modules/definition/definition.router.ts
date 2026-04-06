import { Router } from "express";
import { z } from "zod";
import * as defService from "./definition.service.js";
import { requireApiKey } from "../../middleware/apiKeyAuth.js";

export const definitionRouter = Router();

// Write operations require admin scope (applied per-route below)
const adminOnly = requireApiKey("admin");

// ─── Zod Schemas ─────────────────────────────────────

const createModelSchema = z.object({
  key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, "key must be lowercase snake_case"),
  name: z.string().min(1),
  description: z.string().optional(),
  geometryType: z.enum(["NONE", "POINT", "LINESTRING", "POLYGON", "MIXED"]).optional(),
  is3D: z.boolean().optional(),
  srid: z.number().int().optional(),
});

const updateModelSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  geometryType: z.enum(["NONE", "POINT", "LINESTRING", "POLYGON", "MIXED"]).optional(),
  is3D: z.boolean().optional(),
  srid: z.number().int().optional(),
});

const createFieldSchema = z.object({
  key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, "key must be lowercase snake_case"),
  label: z.string().min(1),
  fieldType: z.enum(["string", "number", "boolean", "date", "json", "enum_", "reference", "geometry"]),
  isRequired: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  enumValues: z.array(z.string()).optional(),
  validationJson: z.record(z.unknown()).optional(),
  referenceModelKey: z.string().optional(),
  orderIndex: z.number().int().optional(),
});


const createBindingSchema = z.object({
  modelDefinitionId: z.string().uuid(),
  filterJson: z.record(z.unknown()).optional(),
  projectionJson: z.record(z.unknown()).optional(),
});

const createPolicySchema = z.object({
  targetType: z.enum(["model", "dataset"]),
  targetId: z.string().uuid(),
  requireProposal: z.boolean().optional(),
  approvalMode: z.enum(["manual", "auto"]).optional(),
  publishMode: z.enum(["manual", "auto"]).optional(),
});

const uuidParam = z.object({ id: z.string().uuid() });

// ─── Model Definition Routes ─────────────────────────

// POST /api/v1/definitions/models
definitionRouter.post("/models", adminOnly, async (req, res, next) => {
  try {
    const data = createModelSchema.parse(req.body);
    const model = await defService.createModelDefinition(data);
    res.status(201).json(model);
  } catch (err) { next(err); }
});

// GET /api/v1/definitions/models
definitionRouter.get("/models", async (_req, res, next) => {
  try {
    const models = await defService.listModelDefinitions();
    res.json(models);
  } catch (err) { next(err); }
});

// GET /api/v1/definitions/models/:id
definitionRouter.get("/models/:id", async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const model = await defService.getModelDefinition(id);
    if (!model) return res.status(404).json({ error: "Model not found" });
    res.json(model);
  } catch (err) { next(err); }
});

// PUT /api/v1/definitions/models/:id
definitionRouter.put("/models/:id", adminOnly, async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const data = updateModelSchema.parse(req.body);
    const model = await defService.updateModelDefinition(id, data);
    res.json(model);
  } catch (err) { next(err); }
});

// DELETE /api/v1/definitions/models/:id
definitionRouter.delete("/models/:id", adminOnly, async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    await defService.deleteModelDefinition(id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// GET /api/v1/definitions/models/:id/schema
definitionRouter.get("/models/:id/schema", async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const schema = await defService.getModelSchema(id);
    if (!schema) return res.status(404).json({ error: "Model not found" });
    res.json(schema);
  } catch (err) { next(err); }
});

// ─── Field Definition Routes ─────────────────────────

// POST /api/v1/definitions/models/:id/fields (single object or array)
definitionRouter.post("/models/:id/fields", adminOnly, async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    if (Array.isArray(req.body)) {
      const items = req.body.map((b: unknown) => createFieldSchema.parse(b));
      const fields = [];
      for (const data of items) {
        fields.push(await defService.addField(id, data));
      }
      res.status(201).json(fields);
    } else {
      const data = createFieldSchema.parse(req.body);
      const field = await defService.addField(id, data);
      res.status(201).json(field);
    }
  } catch (err) { next(err); }
});

// PUT /api/v1/definitions/models/:modelId/fields/:fieldId
definitionRouter.put("/models/:modelId/fields/:fieldId", adminOnly, async (req, res, next) => {
  try {
    const { fieldId } = z.object({ fieldId: z.string().uuid() }).parse({ fieldId: req.params.fieldId });
    const data = createFieldSchema.partial().parse(req.body);
    const field = await defService.updateField(fieldId, data);
    res.json(field);
  } catch (err) { next(err); }
});

// DELETE /api/v1/definitions/models/:modelId/fields/:fieldId
definitionRouter.delete("/models/:modelId/fields/:fieldId", adminOnly, async (req, res, next) => {
  try {
    const { fieldId } = z.object({ fieldId: z.string().uuid() }).parse({ fieldId: req.params.fieldId });
    await defService.removeField(fieldId);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ─── Dataset Model Binding Routes ────────────────────

// POST /api/v1/definitions/datasets/:datasetId/bindings
definitionRouter.post("/datasets/:datasetId/bindings", adminOnly, async (req, res, next) => {
  try {
    const datasetId = z.string().uuid().parse(req.params.datasetId);
    const data = createBindingSchema.parse(req.body);
    const binding = await defService.createBinding({
      datasetDefinitionId: datasetId,
      ...data,
    });
    res.status(201).json(binding);
  } catch (err) { next(err); }
});

// GET /api/v1/definitions/datasets/:datasetId/bindings
definitionRouter.get("/datasets/:datasetId/bindings", async (req, res, next) => {
  try {
    const datasetId = z.string().uuid().parse(req.params.datasetId);
    const bindings = await defService.listBindings(datasetId);
    res.json(bindings);
  } catch (err) { next(err); }
});

// PUT /api/v1/definitions/datasets/:datasetId/bindings/:bindingId
definitionRouter.put("/datasets/:datasetId/bindings/:bindingId", adminOnly, async (req, res, next) => {
  try {
    const bindingId = z.string().uuid().parse(req.params.bindingId);
    const binding = await defService.updateBinding(bindingId, req.body);
    res.json(binding);
  } catch (err) { next(err); }
});

// DELETE /api/v1/definitions/datasets/:datasetId/bindings/:bindingId
definitionRouter.delete("/datasets/:datasetId/bindings/:bindingId", adminOnly, async (req, res, next) => {
  try {
    const bindingId = z.string().uuid().parse(req.params.bindingId);
    await defService.removeBinding(bindingId);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ─── Governance Policy Routes ────────────────────────

// POST /api/v1/definitions/governance/policies
definitionRouter.post("/governance/policies", adminOnly, async (req, res, next) => {
  try {
    const data = createPolicySchema.parse(req.body);
    const policy = await defService.upsertGovernancePolicy(data);
    res.status(201).json(policy);
  } catch (err) { next(err); }
});

// GET /api/v1/definitions/governance/policies/:targetType/:targetId
definitionRouter.get("/governance/policies/:targetType/:targetId", async (req, res, next) => {
  try {
    const targetType = z.enum(["model", "dataset"]).parse(req.params.targetType);
    const targetId = z.string().uuid().parse(req.params.targetId);
    const policy = await defService.getGovernancePolicy(targetType, targetId);
    if (!policy) return res.status(404).json({ error: "Policy not found" });
    res.json(policy);
  } catch (err) { next(err); }
});

// DELETE /api/v1/definitions/governance/policies/:id
definitionRouter.delete("/governance/policies/:id", adminOnly, async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    await defService.deleteGovernancePolicy(id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});
