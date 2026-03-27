import { Router } from "express";
import * as publicationService from "./publication.service.js";
import { publishSchema, rollbackSchema } from "../../shared/validation.js";

export const publicationRouter = Router();

// GET /api/v1/publications
publicationRouter.get("/", async (_req, res, next) => {
  try {
    const publications = await publicationService.listPublications();
    res.json(publications);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/publications/publish
publicationRouter.post("/publish", async (req, res, next) => {
  try {
    const { datasetSnapshotId } = publishSchema.parse(req.body);
    const result =
      await publicationService.publishSnapshot(datasetSnapshotId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/publications/rollback
publicationRouter.post("/rollback", async (req, res, next) => {
  try {
    const { datasetDefinitionId } = rollbackSchema.parse(req.body);
    const result = await publicationService.rollback(datasetDefinitionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
