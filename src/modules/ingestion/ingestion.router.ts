import { Router } from "express";
import { z } from "zod";
import * as ingestionService from "./ingestion.service.js";

export const ingestionRouter = Router();

const geoJsonSchema = z.object({
  type: z.enum([
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
  ]),
  coordinates: z.unknown(),
});

const importSchema = z.object({
  entities: z
    .array(
      z.object({
        type: z.string().min(1),
        properties: z.record(z.unknown()),
        geometry: geoJsonSchema.nullish(),
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
        geometry: geoJsonSchema.nullish(),
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
            geometry: geoJsonSchema.nullish(),
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
      data.entities,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ingestion/import
ingestionRouter.post("/import", async (req, res, next) => {
  try {
    const data = importSchema.parse(req.body);
    const result = await ingestionService.bulkImport(
      data.entities,
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
      data.proposals,
      data.source,
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
