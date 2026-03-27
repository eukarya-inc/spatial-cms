import "dotenv/config";
import express from "express";
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
    console.error(err);
    res.status(500).json({ error: err.message });
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
