import { z } from "zod";

// --- Geometry ---

const geoJsonGeometrySchema = z.object({
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

// --- Proposal ---

export const createProposalSchema = z.object({
  entityId: z.string().uuid().optional(),
  proposedChange: z.object({
    action: z.enum(["create", "update"]),
    data: z.object({
      type: z.string().min(1).optional(),
      properties: z.record(z.unknown()).optional(),
      geometry: geoJsonGeometrySchema.optional(),
      status: z.enum(["draft", "active", "archived"]).optional(),
    }),
  }),
  source: z.enum(["human", "machine", "import_"]).optional(),
});

// --- Dataset Definition ---

export const createDatasetDefinitionSchema = z.object({
  name: z.string().min(1),
  entityTypes: z.array(z.string().min(1)).min(1),
  filterRule: z.record(z.unknown()).optional(),
  projectionRule: z.record(z.unknown()).optional(),
  primaryGeometryRule: z.record(z.unknown()).optional(),
});

// --- Publication ---

export const publishSchema = z.object({
  datasetSnapshotId: z.string().uuid(),
});

export const rollbackSchema = z.object({
  datasetDefinitionId: z.string().uuid(),
});

// --- Params ---

export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});
