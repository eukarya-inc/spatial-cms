import { Router } from "express";
import * as datasetService from "./dataset.service.js";

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
    const dataset = await datasetService.getDatasetDefinition(req.params.id);
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
    const dataset = await datasetService.createDatasetDefinition(req.body);
    res.status(201).json(dataset);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/datasets/:id/snapshot
datasetRouter.post("/:id/snapshot", async (req, res, next) => {
  try {
    const snapshot = await datasetService.generateSnapshot(req.params.id);
    res.status(201).json(snapshot);
  } catch (err) {
    next(err);
  }
});
