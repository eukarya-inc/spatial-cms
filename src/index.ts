import "dotenv/config";
import express from "express";
import { ZodError } from "zod";
import prisma from "./db/client.js";
import { entityRouter } from "./modules/entity/entity.router.js";
import { proposalRouter } from "./modules/proposal/proposal.router.js";
import { datasetRouter } from "./modules/dataset/dataset.router.js";
import { publicationRouter } from "./modules/publication/publication.router.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

    // Business logic errors (from service layer) → 400
    const businessErrors = [
      "not found",
      "not pending",
      "required for",
      "must be in",
      "Unknown action",
      "No active release",
      "No previous snapshot",
    ];
    if (businessErrors.some((msg) => err.message.includes(msg))) {
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
