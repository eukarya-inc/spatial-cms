import path from "path";
import express from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "./db/client.js";
import { BusinessError, NotFoundError } from "./shared/errors.js";
import { entityRouter } from "./modules/entity/entity.router.js";
import { proposalRouter } from "./modules/proposal/proposal.router.js";
import { datasetRouter } from "./modules/dataset/dataset.router.js";
import { publicationRouter } from "./modules/publication/publication.router.js";
import { ingestionRouter } from "./modules/ingestion/ingestion.router.js";
import { definitionRouter } from "./modules/definition/definition.router.js";
import { deliveryRouter } from "./modules/delivery/delivery.router.js";
import { ogcRouter } from "./modules/delivery/ogc.router.js";
import { apiKeyRouter } from "./modules/api-keys/api-key.router.js";
import { templateRouter } from "./modules/template/template.router.js";
import { requireApiKey } from "./middleware/apiKeyAuth.js";

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

// Health check
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: "error", message: "Database unreachable" });
  }
});

// Auth config (public, no auth needed — frontend uses this to discover Keycloak + environment)
app.get("/api/v1/auth/config", (req, res) => {
  let keycloakUrl = process.env.KEYCLOAK_URL;
  const keycloakRealm = process.env.KEYCLOAK_REALM;
  const isDevelopment = process.env.NODE_ENV !== "production";
  if (keycloakUrl && keycloakRealm) {
    // Replace localhost with request host for LAN access
    if (keycloakUrl.includes("localhost")) {
      const host = req.get("host")?.split(":")[0] || "localhost";
      keycloakUrl = keycloakUrl.replace("localhost", host);
    }
    res.json({ keycloakUrl, keycloakRealm, clientId: "spatial-cms-ui", isDevelopment });
  } else {
    res.json({ keycloakUrl: null, keycloakRealm: null, isDevelopment });
  }
});

// CORS for all API routes (external tools, viewer, workbench)
app.use("/api/v1", (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// Public routes (no auth)
import { bootstrapKey, isRequired } from "./modules/api-keys/api-key.service.js";
app.get("/api/v1/api-keys/status", (_req, res) => { res.json({ required: isRequired() }); });
app.post("/api/v1/api-keys/bootstrap", async (req, res, next) => {
  try {
    const result = await bootstrapKey();
    if (!result) { res.status(403).json({ error: "Bootstrap not available. Keys already exist." }); return; }
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// API routes (protected by scope-based API Key)
app.use("/api/v1/entities", requireApiKey("manage"), entityRouter);
app.use("/api/v1/proposals", requireApiKey("manage"), proposalRouter);
app.use("/api/v1/datasets", requireApiKey("manage"), datasetRouter);
app.use("/api/v1/publications", requireApiKey("manage"), publicationRouter);
app.use("/api/v1/ingestion", requireApiKey("manage"), ingestionRouter);
app.use("/api/v1/definitions", requireApiKey("manage"), definitionRouter);
app.use("/api/v1/api-keys", requireApiKey("admin"), apiKeyRouter);
app.use("/api/v1/templates", requireApiKey("manage"), templateRouter);
app.use("/api/v1/delivery", requireApiKey("delivery"), deliveryRouter);
app.use("/api/v1/ogc", ogcRouter);

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "Validation error",
        details: err.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof BusinessError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2025") {
        res.status(404).json({ error: "Record not found" });
        return;
      }
      if (err.code === "P2002") {
        res
          .status(409)
          .json({
            error:
              "Duplicate record: a record with this value already exists",
          });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  },
);

export default app;
