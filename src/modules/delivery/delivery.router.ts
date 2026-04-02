import { Router } from "express";
import { z } from "zod";
import * as deliveryService from "./delivery.service.js";

export const deliveryRouter = Router();

const uuidParam = z.object({ id: z.string().uuid() });

// Parse query params into QueryOptions
function parseQueryOptions(query: Record<string, unknown>) {
  const options: Record<string, unknown> = {};

  // Pagination
  if (query.page) options.page = Math.max(1, parseInt(String(query.page)));
  if (query.pageSize) options.pageSize = parseInt(String(query.pageSize));

  // Spatial: bbox=minLon,minLat,maxLon,maxLat
  if (query.bbox) {
    const parts = String(query.bbox).split(",").map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      options.bbox = parts as unknown;
    }
  }

  // Spatial: near=lon,lat&radius=meters
  if (query.near) {
    const parts = String(query.near).split(",").map(Number);
    const radius = query.radius ? Number(query.radius) : 1000;
    if (parts.length === 2 && parts.every((n) => !isNaN(n)) && !isNaN(radius)) {
      options.near = { lon: parts[0], lat: parts[1], radius };
    }
  }

  // Filter: Express parses filter[field]=value into { filter: { field: value } }
  // and filter[field][$gte]=100 into { filter: { field: { $gte: "100" } } }
  if (query.filter && typeof query.filter === "object") {
    options.filter = query.filter as Record<string, Record<string, string> | string>;
  }

  // Sort: sort=field:order
  if (query.sort) {
    const parts = String(query.sort).split(":");
    options.sort = {
      field: parts[0],
      order: parts[1] === "desc" ? "desc" : "asc",
    };
  }

  // Format
  if (query.format === "geojson") options.format = "geojson";

  return options;
}

// GET /api/v1/delivery/datasets
deliveryRouter.get("/datasets", async (_req, res, next) => {
  try {
    const datasets = await deliveryService.listPublishedDatasets('delivery');
    res.json(datasets);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/delivery/datasets/:id
deliveryRouter.get("/datasets/:id", async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const dataset = await deliveryService.getPublishedDataset(id);
    if (!dataset)
      return res
        .status(404)
        .json({ error: "Dataset not published or not found" });
    res.json(dataset);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/delivery/datasets/:id/schema
deliveryRouter.get("/datasets/:id/schema", async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const schema = await deliveryService.getPublishedDatasetSchema(id);
    if (!schema)
      return res
        .status(404)
        .json({ error: "Dataset not published or not found" });
    res.json(schema);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/delivery/datasets/:id/models
deliveryRouter.get("/datasets/:id/models", async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const models = await deliveryService.listPublishedDatasetModels(id);
    if (!models) return res.status(404).json({ error: "Dataset not published or not found" });
    res.json(models);
  } catch (err) { next(err); }
});

// GET /api/v1/delivery/datasets/:id/models/:key/schema
deliveryRouter.get("/datasets/:id/models/:key/schema", async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const key = req.params.key;
    const schema = await deliveryService.getPublishedModelSchema(id, key);
    if (!schema) return res.status(404).json({ error: "Model not found in this dataset" });
    res.json(schema);
  } catch (err) { next(err); }
});

// GET /api/v1/delivery/datasets/:id/models/:key/entities
deliveryRouter.get("/datasets/:id/models/:key/entities", async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const options = parseQueryOptions(req.query as Record<string, unknown>);
    options.modelKey = req.params.key;
    const result = await deliveryService.getPublishedEntities(id, options);
    if (!result) return res.status(404).json({ error: "Dataset not published or not found" });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/v1/delivery/datasets/:id/entities
deliveryRouter.get("/datasets/:id/entities", async (req, res, next) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const options = parseQueryOptions(req.query as Record<string, unknown>);
    const result = await deliveryService.getPublishedEntities(id, options);
    if (!result)
      return res
        .status(404)
        .json({ error: "Dataset not published or not found" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/delivery/datasets/:id/entities/:entityId
deliveryRouter.get("/datasets/:id/entities/:entityId", async (req, res, next) => {
  try {
    const datasetId = z.string().uuid().parse(req.params.id);
    const entityId = z.string().uuid().parse(req.params.entityId);
    const entity = await deliveryService.getPublishedEntity(datasetId, entityId);
    if (!entity)
      return res
        .status(404)
        .json({ error: "Entity not found in this published dataset" });
    res.json(entity);
  } catch (err) {
    next(err);
  }
});
