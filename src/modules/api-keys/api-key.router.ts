import { Router } from "express";
import { z } from "zod";
import * as apiKeyService from "./api-key.service.js";

export const apiKeyRouter = Router();

// GET /api/v1/api-keys/status
apiKeyRouter.get("/status", async (_req, res) => {
  res.json({ required: apiKeyService.isRequired() });
});


// GET /api/v1/api-keys
apiKeyRouter.get("/", async (_req, res, next) => {
  try {
    const keys = await apiKeyService.listKeys();
    res.json(keys);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/api-keys
apiKeyRouter.post("/", async (req, res, next) => {
  try {
    const { name, scope } = z.object({ name: z.string().min(1), scope: z.string().optional() }).parse(req.body);
    const result = await apiKeyService.generateKey(name, scope);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/api-keys/:id
apiKeyRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    await apiKeyService.revokeKey(id);
    res.json({ revoked: true });
  } catch (err) {
    next(err);
  }
});
