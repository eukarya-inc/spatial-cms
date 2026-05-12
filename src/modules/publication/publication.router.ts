import { Router } from "express";
import * as publicationService from "./publication.service.js";
import { publishSchema, rollbackSchema } from "../../shared/validation.js";
import { workspaceId } from "../../shared/workspace.js";

export const publicationRouter = Router();

// GET /api/v1/publications
publicationRouter.get("/", async (req, res, next) => {
  try {
    const publications = await publicationService.listPublications(workspaceId(req));
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
      await publicationService.publishSnapshot(workspaceId(req), datasetSnapshotId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/publications/hook — simulate sending to Serve
publicationRouter.post("/hook", async (req, res, next) => {
  try {
    const { datasetSnapshotId } = publishSchema.parse(req.body);
    const result =
      await publicationService.triggerPublishHook(workspaceId(req), datasetSnapshotId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/publications/rollback
publicationRouter.post("/rollback", async (req, res, next) => {
  try {
    const { datasetDefinitionId } = rollbackSchema.parse(req.body);
    const result = await publicationService.rollback(workspaceId(req), datasetDefinitionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
