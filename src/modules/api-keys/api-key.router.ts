import { Router } from "express";
import { z } from "zod";
import * as apiKeyService from "./api-key.service.js";
import { workspaceId } from "../../shared/workspace.js";

export const apiKeyRouter = Router();

// GET /api/v1/api-keys — list keys in caller's workspace only
// (`/status` and `/bootstrap` are registered as standalone public routes in app.ts,
// so they bypass this router's auth + workspace chain.)
apiKeyRouter.get("/", async (req, res, next) => {
  try {
    const ws = workspaceId(req);
    const keys = await apiKeyService.listKeys(ws);
    res.json(keys);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/api-keys — create key, always for caller's workspace
apiKeyRouter.post("/", async (req, res, next) => {
  try {
    const { name, scope } = z.object({ name: z.string().min(1), scope: z.string().optional() }).parse(req.body);
    const ws = workspaceId(req);
    const result = await apiKeyService.generateKey(name, scope ?? "delivery", ws);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/api-keys/:id — revoke; refuses cross-workspace via NotFound
apiKeyRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const ws = workspaceId(req);
    await apiKeyService.revokeKey(ws, id);
    res.json({ revoked: true });
  } catch (err) {
    next(err);
  }
});
