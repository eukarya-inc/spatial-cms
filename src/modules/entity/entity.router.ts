import { Router } from "express";
import * as entityService from "./entity.service.js";
import { uuidParamSchema } from "../../shared/validation.js";

export const entityRouter = Router();

// GET /api/v1/entities
entityRouter.get("/", async (req, res, next) => {
  try {
    const query = req.query;
    const options: Record<string, unknown> = {};

    if (query.type) options.type = String(query.type);
    if (query.status) options.status = String(query.status);
    if (query.page) options.page = Math.max(1, parseInt(String(query.page)));
    if (query.pageSize) options.pageSize = parseInt(String(query.pageSize));

    // Spatial: bbox=minLon,minLat,maxLon,maxLat
    if (query.bbox) {
      const parts = String(query.bbox).split(",").map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        options.bbox = parts;
      }
    }

    // Spatial: near=lon,lat&radius=meters
    if (query.near) {
      const parts = String(query.near).split(",").map(Number);
      const radius = query.radius ? Number(query.radius) : 1000;
      if (parts.length === 2 && parts.every((n) => !isNaN(n))) {
        options.near = { lon: parts[0], lat: parts[1], radius };
      }
    }

    // Sort: sort=field:order
    if (query.sort) {
      const parts = String(query.sort).split(":");
      options.sort = { field: parts[0], order: parts[1] === "desc" ? "desc" : "asc" };
    }

    const result = await entityService.listEntities(options);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/entities/:id/versions
entityRouter.get("/:id/versions", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const versions = await entityService.getEntityVersions(id);
    res.json(versions);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/entities/:id/restore
entityRouter.post("/:id/restore", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const entity = await entityService.restoreEntity(id);
    res.json(entity);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/entities/:id/purge
entityRouter.delete("/:id/purge", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const result = await entityService.purgeEntity(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/entities/:id
entityRouter.get("/:id", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const entity = await entityService.getEntity(id);
    if (!entity) return res.status(404).json({ error: "Entity not found" });
    res.json(entity);
  } catch (err) {
    next(err);
  }
});
