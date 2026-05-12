import { Router } from "express";
import { z } from "zod";
import * as workspaceService from "./workspace.service.js";
import { requireApiKey } from "../../middleware/apiKeyAuth.js";

export const workspaceRouter = Router();

const adminOnly = requireApiKey("admin");

const createSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/, "slug must be lowercase letters/digits/_/-, starting with a letter"),
  name: z.string().min(1),
  description: z.string().optional(),
});

// GET /api/v1/workspaces — visible to everyone (no scope check)
workspaceRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await workspaceService.listWorkspaces());
  } catch (err) { next(err); }
});

// GET /api/v1/workspaces/:slug
workspaceRouter.get("/:slug", async (req, res, next) => {
  try {
    const ws = await workspaceService.getWorkspaceBySlug(req.params.slug);
    res.json(ws);
  } catch (err) { next(err); }
});

// POST /api/v1/workspaces
workspaceRouter.post("/", adminOnly, async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const ws = await workspaceService.createWorkspace(data);
    res.status(201).json(ws);
  } catch (err) { next(err); }
});

// DELETE /api/v1/workspaces/:slug
workspaceRouter.delete("/:slug", adminOnly, async (req, res, next) => {
  try {
    await workspaceService.deleteWorkspace(String(req.params.slug));
    res.json({ deleted: true });
  } catch (err) { next(err); }
});
