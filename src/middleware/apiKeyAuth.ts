import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import prisma from "../db/client.js";

const SCOPE_LEVELS: Record<string, number> = {
  delivery: 1,
  manage: 2,
  admin: 3,
};

export function requireApiKey(requiredScope: string = "delivery") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.DELIVERY_API_KEY_REQUIRED === "false") {
      return next();
    }

    const rawKey = req.header("X-API-Key");
    if (!rawKey) {
      res.status(401).json({ error: "Missing X-API-Key header" });
      return;
    }

    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    prisma.apiKey
      .findUnique({ where: { keyHash } })
      .then((apiKey) => {
        if (!apiKey || apiKey.revokedAt) {
          res.status(403).json({ error: "Invalid or revoked API key" });
          return;
        }
        const keyLevel = SCOPE_LEVELS[apiKey.scope] ?? 0;
        const requiredLevel = SCOPE_LEVELS[requiredScope] ?? 0;
        if (keyLevel < requiredLevel) {
          res.status(403).json({ error: `Insufficient scope. Required: ${requiredScope}, got: ${apiKey.scope}` });
          return;
        }
        next();
      })
      .catch(next);
  };
}
