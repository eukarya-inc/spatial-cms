import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import prisma from "../db/client.js";
import { extractJwtAuth } from "./jwtAuth.js";

declare global {
  namespace Express {
    interface Request {
      // Set by requireApiKey when API-key auth (vs JWT) was used. Downstream
      // middleware (resolveWorkspace) reads this to enforce that the key's
      // workspace matches the request's workspace.
      apiKey?: { id: string; scope: string; workspaceId: string };
    }
  }
}

const SCOPE_LEVELS: Record<string, number> = {
  delivery: 1,
  manage: 2,
  admin: 3,
};

function hasScope(keyScope: string, requiredScope: string): boolean {
  return (SCOPE_LEVELS[keyScope] ?? 0) >= (SCOPE_LEVELS[requiredScope] ?? 0);
}

export function requireApiKey(requiredScope: string = "delivery") {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Dev mode: skip all auth
    if (process.env.DELIVERY_API_KEY_REQUIRED === "false") {
      return next();
    }

    // Try 1: JWT (Keycloak) — Authorization: Bearer <token>
    const jwtAuth = await extractJwtAuth(req);
    if (jwtAuth) {
      if (!hasScope(jwtAuth.scope, requiredScope)) {
        res.status(403).json({ error: `Insufficient role. Required scope: ${requiredScope}, your roles: ${jwtAuth.roles.join(", ")}` });
        return;
      }
      // JWT users are platform-level (no workspace binding in this iteration);
      // resolveWorkspace skips the workspace match when req.apiKey is unset.
      return next();
    }

    // Try 2: API Key — X-API-Key header
    const rawKey = req.header("X-API-Key");
    if (!rawKey) {
      res.status(401).json({ error: "Authentication required. Use Authorization: Bearer <token> or X-API-Key header." });
      return;
    }

    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    try {
      const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
      if (!apiKey || apiKey.revokedAt) {
        res.status(403).json({ error: "Invalid or revoked API key" });
        return;
      }
      if (!hasScope(apiKey.scope, requiredScope)) {
        res.status(403).json({ error: `Insufficient scope. Required: ${requiredScope}, got: ${apiKey.scope}` });
        return;
      }
      // Stash for resolveWorkspace's workspace-match check
      req.apiKey = { id: apiKey.id, scope: apiKey.scope, workspaceId: apiKey.workspaceId };
      next();
    } catch (err) {
      next(err);
    }
  };
}
