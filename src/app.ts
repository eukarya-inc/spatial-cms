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

const app = express();

app.use(express.json());
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

// API routes
app.use("/api/v1/entities", entityRouter);
app.use("/api/v1/proposals", proposalRouter);
app.use("/api/v1/datasets", datasetRouter);
app.use("/api/v1/publications", publicationRouter);
app.use("/api/v1/ingestion", ingestionRouter);
app.use("/api/v1/definitions", definitionRouter);

// Delivery + OGC: enable CORS for external consumers
const corsHeaders = (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
};
app.use("/api/v1/delivery", corsHeaders, deliveryRouter);
app.use("/api/v1/ogc", corsHeaders, ogcRouter);

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
