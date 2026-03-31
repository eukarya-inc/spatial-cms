import "dotenv/config";
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

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use("/api/v1/delivery", deliveryRouter);

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    // Zod validation errors → 400
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

    // Custom error classes
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof BusinessError) {
      res.status(400).json({ error: err.message });
      return;
    }

    // Prisma known errors (constraint violations, not found, etc.)
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2025") {
        res.status(404).json({ error: "Record not found" });
        return;
      }
      if (err.code === "P2002") {
        res.status(409).json({ error: "Duplicate record: a record with this value already exists" });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }

    // Unexpected errors → 500
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  },
);

const server = app.listen(PORT, () => {
  console.log(`Spatial CMS running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});
