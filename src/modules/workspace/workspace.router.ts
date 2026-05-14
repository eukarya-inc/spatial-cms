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

const updateSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .refine((d) => d.name !== undefined || d.description !== undefined, {
    message: "Provide at least one of: name, description",
  });

// GET /api/v1/workspaces — visible to everyone (no scope check)
workspaceRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await workspaceService.listWorkspaces());
  } catch (err) { next(err); }
});

// GET /api/v1/workspaces/locate/{entity|model|dataset}/:id
// Returns the workspace that owns the given record, or 404. Used by the
// frontend to recover from cross-workspace 404s.
workspaceRouter.get("/locate/:kind/:id", async (req, res, next) => {
  try {
    const kind = z.enum(["entity", "model", "dataset"]).parse(req.params.kind);
    const id = z.string().uuid().parse(req.params.id);
    let ws;
    if (kind === "entity") ws = await workspaceService.locateEntity(id);
    else if (kind === "model") ws = await workspaceService.locateModel(id);
    else ws = await workspaceService.locateDataset(id);
    if (!ws) return res.status(404).json({ error: `${kind} not found in any workspace` });
    res.json({ workspace: { id: ws.id, slug: ws.slug, name: ws.name } });
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

// PATCH /api/v1/workspaces/:slug — rename (name and/or description only)
workspaceRouter.patch("/:slug", adminOnly, async (req, res, next) => {
  try {
    const data = updateSchema.parse(req.body);
    const ws = await workspaceService.updateWorkspace(String(req.params.slug), data);
    res.json(ws);
  } catch (err) { next(err); }
});

// DELETE /api/v1/workspaces/:slug
workspaceRouter.delete("/:slug", adminOnly, async (req, res, next) => {
  try {
    await workspaceService.deleteWorkspace(String(req.params.slug));
    res.json({ deleted: true });
  } catch (err) { next(err); }
});
