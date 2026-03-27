import { Router } from "express";
import * as entityService from "./entity.service.js";

export const entityRouter = Router();

// GET /api/v1/entities
entityRouter.get("/", async (req, res, next) => {
  try {
    const entities = await entityService.listEntities({
      type: req.query.type as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json(entities);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/entities/:id
entityRouter.get("/:id", async (req, res, next) => {
  try {
    const entity = await entityService.getEntity(req.params.id);
    if (!entity) return res.status(404).json({ error: "Entity not found" });
    res.json(entity);
  } catch (err) {
    next(err);
  }
});
