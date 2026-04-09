import { Router, Request } from "express";
import { z } from "zod";
import prisma from "../../db/client.js";
import * as deliveryService from "./delivery.service.js";

export const ogcRouter = Router();

function baseUrl(req: Request) {
  return `${req.protocol}://${req.get("host")}/api/v1/ogc`;
}

/** Parse collection ID "datasetId_modelKey" (underscore after UUID) */
function parseCollectionId(collectionId: string) {
  // UUID is 36 chars (8-4-4-4-12), then underscore, then model key
  if (collectionId.length < 38 || collectionId[36] !== '_') return null;
  return { datasetId: collectionId.substring(0, 36), modelKey: collectionId.substring(37) };
}

// GET /api/v1/ogc/
ogcRouter.get("/", async (req, res) => {
  const base = baseUrl(req);
  res.json({
    title: "Spatial CMS OGC API",
    description: "OGC API - Features for published spatial data",
    links: [
      { rel: "self", href: `${base}`, type: "application/json", title: "This document" },
      { rel: "conformance", href: `${base}/conformance`, type: "application/json", title: "Conformance declaration" },
      { rel: "data", href: `${base}/collections`, type: "application/json", title: "Collections" },
      { rel: "service-desc", href: `${base}/api`, type: "application/vnd.oai.openapi+json;version=3.0", title: "API description" },
    ],
  });
});

// GET /api/v1/ogc/api (minimal OpenAPI stub for QGIS discovery)
ogcRouter.get("/api", async (req, res) => {
  const base = baseUrl(req);
  res.json({
    openapi: "3.0.0",
    info: { title: "Spatial CMS OGC API", version: "1.0.0" },
    paths: {
      "/collections": { get: { summary: "List collections" } },
      "/collections/{collectionId}/items": { get: { summary: "Get features" } },
    },
  });
});

// GET /api/v1/ogc/conformance
ogcRouter.get("/conformance", async (_req, res) => {
  res.json({
    conformsTo: [
      "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
      "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
    ],
  });
});

// GET /api/v1/ogc/collections — each binding from OGC-enabled datasets = one collection
ogcRouter.get("/collections", async (req, res, next) => {
  try {
    const base = baseUrl(req);
    const datasets = await deliveryService.listPublishedDatasets('ogc');

    // For each dataset, get its bindings to create per-model collections
    const collections = [];
    for (const d of datasets) {
      const bindings = await prisma.datasetModelBinding.findMany({
        where: { datasetDefinitionId: d.id },
        include: {
          modelDefinition: {
            include: { fields: true },
          },
        },
      });
      for (const b of bindings) {
        const m = b.modelDefinition;
        const collectionId = `${d.id}_${m.key}`;
        // Resolve SRID from primaryGeometryField
        const geoField = m.primaryGeometryField
          ? m.fields.find((f) => f.key === m.primaryGeometryField)
          : null;
        const srid = geoField?.geometrySrid ?? 4326;
        collections.push({
          id: collectionId,
          title: m.name,
          description: d.description || `${m.key} from ${d.name}`,
          links: [
            { rel: "self", href: `${base}/collections/${collectionId}`, type: "application/json" },
            { rel: "items", href: `${base}/collections/${collectionId}/items`, type: "application/geo+json" },
          ],
          extent: {
            spatial: { bbox: [[-180, -90, 180, 90]] },
          },
          storageCrs: `http://www.opengis.net/def/crs/EPSG/0/${srid}`,
          ...(d.license ? { license: d.license } : {}),
        });
      }
    }

    res.json({
      collections,
      links: [{ rel: "self", href: `${base}/collections`, type: "application/json" }],
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/ogc/collections/:collectionId
ogcRouter.get("/collections/:collectionId", async (req, res, next) => {
  try {
    const base = baseUrl(req);
    const parsed = parseCollectionId(req.params.collectionId);
    if (!parsed) return res.status(404).json({ error: "Invalid collection ID format. Expected: datasetId--modelKey" });

    const dataset = await deliveryService.getPublishedDataset(parsed.datasetId);
    if (!dataset) return res.status(404).json({ error: "Collection not found" });

    const models = await deliveryService.listPublishedDatasetModels(parsed.datasetId);
    const model = models?.find((m) => m.key === parsed.modelKey);
    if (!model) return res.status(404).json({ error: "Model not found in this dataset" });

    res.json({
      id: req.params.collectionId,
      title: model.name,
      description: `${model.key} from ${dataset.name}`,
      links: [
        { rel: "self", href: `${base}/collections/${req.params.collectionId}`, type: "application/json" },
        { rel: "items", href: `${base}/collections/${req.params.collectionId}/items`, type: "application/geo+json" },
      ],
      extent: { spatial: { bbox: [[-180, -90, 180, 90]] } },
      storageCrs: `http://www.opengis.net/def/crs/EPSG/0/${model.srid}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/ogc/collections/:collectionId/schema
ogcRouter.get("/collections/:collectionId/schema", async (req, res, next) => {
  try {
    const parsed = parseCollectionId(req.params.collectionId);
    if (!parsed) return res.status(404).json({ error: "Invalid collection ID" });

    const schema = await deliveryService.getPublishedModelSchema(parsed.datasetId, parsed.modelKey);
    if (!schema) return res.status(404).json({ error: "Collection not found" });

    const properties: Record<string, object> = {};
    const typeMap: Record<string, string> = { string: "string", number: "number", boolean: "boolean", date: "string", json: "object", enum_: "string", reference: "string" };
    for (const f of (schema.fields || []) as Array<{ key: string; label: string; fieldType: string; isRequired: boolean }>) {
      properties[f.key] = {
        title: f.label,
        type: typeMap[f.fieldType] || "string",
        "x-ogc-role": f.isRequired ? "required" : "optional",
      };
    }

    res.json({
      type: "object",
      title: schema.name,
      properties: {
        type: { type: "string", enum: ["Feature"] },
        geometry: { type: "object" },
        properties: { type: "object", properties },
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/ogc/collections/:collectionId/items
ogcRouter.get("/collections/:collectionId/items", async (req, res, next) => {
  try {
    const base = baseUrl(req);
    const parsed = parseCollectionId(req.params.collectionId);
    if (!parsed) return res.status(404).json({ error: "Invalid collection ID" });

    const query = req.query;
    const limit = Math.min(Math.max(parseInt(String(query.limit)) || 10, 1), 100000);
    const offset = Math.max(parseInt(String(query.offset)) || 0, 0);
    const page = Math.floor(offset / limit) + 1;

    const options: Record<string, unknown> = {
      page,
      pageSize: limit,
      format: "geojson",
      modelKey: parsed.modelKey,
    };

    if (query.bbox) {
      const parts = String(query.bbox).split(",").map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        options.bbox = parts;
      }
    }

    const result = await deliveryService.getPublishedEntities(parsed.datasetId, options);
    if (!result) return res.status(404).json({ error: "Collection not found" });

    const fc = result as {
      type: string;
      features: unknown[];
      metadata: { total: number; page: number; pageSize: number; totalPages: number };
    };

    const collId = req.params.collectionId;
    const links = [
      { rel: "self", href: `${base}/collections/${collId}/items?limit=${limit}&offset=${offset}`, type: "application/geo+json" },
    ];
    if (offset + limit < fc.metadata.total) {
      links.push({ rel: "next", href: `${base}/collections/${collId}/items?limit=${limit}&offset=${offset + limit}`, type: "application/geo+json" });
    }
    if (offset > 0) {
      links.push({ rel: "prev", href: `${base}/collections/${collId}/items?limit=${limit}&offset=${Math.max(0, offset - limit)}`, type: "application/geo+json" });
    }

    res.json({
      type: "FeatureCollection",
      numberReturned: fc.features.length,
      numberMatched: fc.metadata.total,
      features: fc.features,
      links,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/ogc/collections/:collectionId/items/:featureId
ogcRouter.get("/collections/:collectionId/items/:featureId", async (req, res, next) => {
  try {
    const base = baseUrl(req);
    const parsed = parseCollectionId(req.params.collectionId);
    if (!parsed) return res.status(404).json({ error: "Invalid collection ID" });

    const featureId = z.string().uuid().parse(req.params.featureId);
    const entity = await deliveryService.getPublishedEntity(parsed.datasetId, featureId);
    if (!entity) return res.status(404).json({ error: "Feature not found in this collection" });

    res.json({
      type: "Feature",
      id: entity.id,
      geometry: entity.geometry || null,
      properties: entity.properties,
      links: [
        { rel: "self", href: `${base}/collections/${req.params.collectionId}/items/${entity.id}`, type: "application/geo+json" },
        { rel: "collection", href: `${base}/collections/${req.params.collectionId}`, type: "application/json" },
      ],
    });
  } catch (err) {
    next(err);
  }
});
