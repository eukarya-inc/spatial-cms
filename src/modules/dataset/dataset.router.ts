import { Router } from "express";
import * as datasetService from "./dataset.service.js";
import {
  createDatasetDefinitionSchema,
  uuidParamSchema,
} from "../../shared/validation.js";

export const datasetRouter = Router();

// GET /api/v1/datasets
datasetRouter.get("/", async (_req, res, next) => {
  try {
    const datasets = await datasetService.listDatasetDefinitions();
    res.json(datasets);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/datasets/:id
datasetRouter.get("/:id", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const dataset = await datasetService.getDatasetDefinition(id);
    if (!dataset)
      return res.status(404).json({ error: "Dataset definition not found" });
    res.json(dataset);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/datasets
datasetRouter.post("/", async (req, res, next) => {
  try {
    const data = createDatasetDefinitionSchema.parse(req.body);
    const dataset = await datasetService.createDatasetDefinition(data);
    res.status(201).json(dataset);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/datasets/:id
datasetRouter.put("/:id", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const dataset = await datasetService.updateDatasetDefinition(id, req.body);
    res.json(dataset);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/datasets/:id
datasetRouter.delete("/:id", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    await datasetService.deleteDatasetDefinition(id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/datasets/:id/snapshot
datasetRouter.post("/:id/snapshot", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const snapshot = await datasetService.generateSnapshot(id);
    res.status(201).json(snapshot);
  } catch (err) {
    next(err);
  }
});
