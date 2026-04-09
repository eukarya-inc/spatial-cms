import { Router } from "express";
import { z } from "zod";
import * as ingestionService from "./ingestion.service.js";

export const ingestionRouter = Router();

// Geometry values now live inside properties (as geometry-typed fields).
// No top-level geometry field in import/proposal schemas.

const importSchema = z.object({
  entities: z
    .array(
      z.object({
        type: z.string().min(1),
        properties: z.record(z.unknown()),
      }),
    )
    .min(1),
  source: z.enum(["human", "machine", "import_"]).optional(),
  options: z
    .object({
      skipInvalid: z.boolean().optional(),
    })
    .optional(),
});

const validateSchema = z.object({
  modelKey: z.string().min(1),
  entities: z
    .array(
      z.object({
        properties: z.record(z.unknown()),
      }),
    )
    .min(1),
});

const proposalSetSchema = z.object({
  proposals: z
    .array(
      z.object({
        entityId: z.string().uuid().optional(),
        proposedChange: z.object({
          action: z.enum(["create", "update"]),
          data: z.object({
            type: z.string().min(1).optional(),
            properties: z.record(z.unknown()).optional(),
            status: z.enum(["draft", "active", "archived"]).optional(),
          }),
        }),
      }),
    )
    .min(1),
  source: z.enum(["human", "machine", "import_"]).optional(),
});

// POST /api/v1/ingestion/validate
ingestionRouter.post("/validate", async (req, res, next) => {
  try {
    const data = validateSchema.parse(req.body);
    const result = await ingestionService.validateBulk(
      data.modelKey,
      data.entities as any,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ingestion/governed
ingestionRouter.post("/governed", async (req, res, next) => {
  try {
    const data = importSchema.parse(req.body);
    const result = await ingestionService.governedImport(
      data.entities as any,
      data.source,
      data.options,
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ingestion/import
ingestionRouter.post("/import", async (req, res, next) => {
  try {
    const data = importSchema.parse(req.body);
    const result = await ingestionService.bulkImport(
      data.entities as any,
      data.source,
      data.options,
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ingestion/proposal-set
ingestionRouter.post("/proposal-set", async (req, res, next) => {
  try {
    const data = proposalSetSchema.parse(req.body);
    const result = await ingestionService.createProposalSet(
      data.proposals as any,
      data.source,
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
