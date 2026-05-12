import type { Request, Response, NextFunction } from "express";
import prisma from "../db/client.js";

declare global {
  namespace Express {
    interface Request {
      workspace?: { id: string; slug: string; name: string };
    }
  }
}

const DEFAULT_SLUG = "default";

/**
 * Resolve current workspace from `X-Workspace-Key` header (or `?workspace=` query).
 * Falls back to the "default" workspace if header missing/unknown — this keeps
 * legacy API clients, tests, and seed scripts working without modification.
 */
export async function resolveWorkspace(req: Request, _res: Response, next: NextFunction) {
  try {
    const headerVal =
      (req.header("X-Workspace-Key") as string | undefined) ||
      (req.query.workspace as string | undefined) ||
      DEFAULT_SLUG;

    let workspace = await prisma.workspace.findUnique({ where: { slug: headerVal } });
    if (!workspace && headerVal !== DEFAULT_SLUG) {
      // Unknown slug → fall back to default rather than 404, preserves backward compat.
      workspace = await prisma.workspace.findUnique({ where: { slug: DEFAULT_SLUG } });
    }
    if (!workspace) {
      // Default workspace missing entirely — migration not run. Hard fail.
      return next(new Error("Default workspace missing — run migrations"));
    }
    req.workspace = { id: workspace.id, slug: workspace.slug, name: workspace.name };
    next();
  } catch (err) {
    next(err as Error);
  }
}

/** Get current workspace id from a request, throws if middleware didn't run. */
export function workspaceId(req: Request): string {
  if (!req.workspace) throw new Error("workspace middleware not applied to this route");
  return req.workspace.id;
}
