import prisma from "../../db/client.js";
import {
  getEntityGeometries,
  findEntitiesInBBox,
  findEntitiesNearPoint,
} from "../../shared/geometry.js";
import { getModelSchemaById } from "../definition/definition.service.js";

interface ManifestItem {
  entityId: string;
  type: string;
  modelDefinitionId: string;
  versionNumber: number;
  snapshot: { properties?: Record<string, unknown> } | null;
}

interface QueryOptions {
  page?: number;
  pageSize?: number;
  bbox?: [number, number, number, number];
  near?: { lon: number; lat: number; radius: number };
  filter?: Record<string, Record<string, string> | string>;
  sort?: { field: string; order: "asc" | "desc" };
  format?: "json" | "geojson";
  modelKey?: string;
}

/** List all datasets that have an active published release, filtered by channel */
export async function listPublishedDatasets(channel?: 'delivery' | 'ogc') {
  const where: Record<string, unknown> = {};
  if (channel === 'delivery') where.datasetDefinition = { publishToDelivery: true };
  if (channel === 'ogc') where.datasetDefinition = { publishToOgc: true };

  const releases = await prisma.activeReleaseState.findMany({
    where,
    include: {
      datasetDefinition: true,
      activeSnapshot: true,
    },
  });

  return releases.map((r) => ({
    id: r.datasetDefinitionId,
    name: r.datasetDefinition.name,
    description: r.datasetDefinition.description,
    license: r.datasetDefinition.license,
    source: r.datasetDefinition.source,
    snapshot: {
      id: r.activeSnapshotId,
      version: r.activeSnapshot.version,
      entityCount: Array.isArray(r.activeSnapshot.manifest)
        ? r.activeSnapshot.manifest.length
        : 0,
      publishedAt: r.updatedAt,
    },
  }));
}

/** Get a specific published dataset with its active snapshot metadata */
export async function getPublishedDataset(datasetDefinitionId: string) {
  const release = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
    include: {
      datasetDefinition: true,
      activeSnapshot: true,
    },
  });

  if (!release) return null;

  const manifest = release.activeSnapshot.manifest as unknown as ManifestItem[];

  const d = release.datasetDefinition;
  return {
    id: release.datasetDefinitionId,
    name: d.name,
    description: d.description,
    license: d.license,
    source: d.source,
    contactName: d.contactName,
    contactEmail: d.contactEmail,
    keywords: d.keywords,
    publishToOgc: d.publishToOgc,
    snapshot: {
      id: release.activeSnapshotId,
      version: release.activeSnapshot.version,
      entityCount: manifest.length,
      publishedAt: release.updatedAt,
    },
  };
}

/** Get entities with filtering, pagination, spatial queries, and format options */
export async function getPublishedEntities(
  datasetDefinitionId: string,
  options: QueryOptions = {},
) {
  const release = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
    include: {
      datasetDefinition: true,
      activeSnapshot: true,
    },
  });

  if (!release) return null;

  const {
    page = 1,
    pageSize = 100,
    bbox,
    near,
    filter,
    sort,
    format = "json",
    modelKey,
  } = options;
  const clampedPageSize = Math.min(Math.max(pageSize, 1), 100000);

  let manifest = release.activeSnapshot.manifest as unknown as ManifestItem[];

  // Filter by model type if specified
  if (modelKey) {
    manifest = manifest.filter((item) => item.type === modelKey);
  }

  // Resolve SRID from dataset's bound models (use first model's primary geometry field SRID)
  const bindings = await prisma.datasetModelBinding.findMany({
    where: { datasetDefinitionId },
    include: {
      modelDefinition: {
        include: { fields: true },
      },
    },
  });
  let datasetSrid = 4326;
  const primaryGeoMap: Record<string, string> = {}; // modelKey → primaryGeometryField
  for (const b of bindings) {
    const m = b.modelDefinition;
    if (m.primaryGeometryField) {
      primaryGeoMap[m.key] = m.primaryGeometryField;
      if (datasetSrid === 4326) {
        const geoField = m.fields.find((f) => f.key === m.primaryGeometryField);
        if (geoField?.geometrySrid) datasetSrid = geoField.geometrySrid;
      }
    }
  }

  // Step 1: Spatial filtering (bbox or near point)
  if (bbox || near) {
    let spatialIds: Set<string>;
    if (bbox) {
      const ids = await findEntitiesInBBox(bbox, datasetSrid);
      spatialIds = new Set(ids);
    } else {
      const ids = await findEntitiesNearPoint(near!.lon, near!.lat, near!.radius, datasetSrid);
      spatialIds = new Set(ids);
    }
    // Intersect with manifest
    manifest = manifest.filter((item) => spatialIds.has(item.entityId));
  }

  // Step 2: Property filtering
  if (filter) {
    manifest = manifest.filter((item) => {
      const props = (item.snapshot?.properties ?? {}) as Record<string, unknown>;
      for (const [key, condition] of Object.entries(filter)) {
        const value = props[key];
        if (typeof condition === "string") {
          // Exact match: ?filter[name]=Tokyo Tower
          if (String(value) !== condition) return false;
        } else if (typeof condition === "object") {
          // Operator match: ?filter[height][$gte]=100
          for (const [op, target] of Object.entries(condition)) {
            const numTarget = Number(target);
            const numValue = Number(value);
            if (op === "$gte" && numValue < numTarget) return false;
            if (op === "$lte" && numValue > numTarget) return false;
            if (op === "$gt" && numValue <= numTarget) return false;
            if (op === "$lt" && numValue >= numTarget) return false;
            if (op === "$ne" && String(value) === target) return false;
          }
        }
      }
      return true;
    });
  }

  // Step 3: Sort
  if (sort) {
    manifest.sort((a, b) => {
      const aVal = (a.snapshot?.properties as Record<string, unknown>)?.[sort.field];
      const bVal = (b.snapshot?.properties as Record<string, unknown>)?.[sort.field];
      const cmp = aVal == null ? 1 : bVal == null ? -1 : aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sort.order === "desc" ? -cmp : cmp;
    });
  }

  // Step 4: Pagination
  const total = manifest.length;
  const totalPages = Math.ceil(total / clampedPageSize);
  const offset = (page - 1) * clampedPageSize;
  const pageItems = manifest.slice(offset, offset + clampedPageSize);

  // Step 5: Merge geometry from entity_geometry table (respects snapshot projection)
  const entities = await Promise.all(
    pageItems.map(async (item) => {
      const properties = (item.snapshot?.properties ?? {}) as Record<string, unknown>;
      try {
        const geos = await getEntityGeometries(item.entityId);
        // Only add geometry fields — don't override projected properties
        for (const [k, v] of Object.entries(geos)) properties[k] = v;
      } catch (err) {
        console.warn(`[Delivery] Failed to fetch geometry for entity ${item.entityId}:`, err instanceof Error ? err.message : err);
      }

      return {
        id: item.entityId,
        type: item.type,
        version: item.versionNumber,
        properties,
      };
    }),
  );

  const datasetMeta = {
    id: release.datasetDefinitionId,
    name: release.datasetDefinition.name,
    snapshotVersion: release.activeSnapshot.version,
    publishedAt: release.updatedAt,
  };

  // Step 6: Format
  if (format === "geojson") {
    return {
      type: "FeatureCollection",
      features: entities.map((e) => {
        const pgf = primaryGeoMap[e.type];
        const geometry = pgf ? (e.properties[pgf] as object ?? null) : null;
        const { [pgf as string]: _geo, ...restProps } = pgf ? e.properties : { ...e.properties };
        return {
          type: "Feature",
          id: e.id,
          properties: { ...restProps, _type: e.type, _version: e.version },
          geometry,
        };
      }),
      metadata: {
        dataset: datasetMeta.name,
        snapshotVersion: datasetMeta.snapshotVersion,
        total,
        page,
        pageSize: clampedPageSize,
        totalPages,
        crs: `EPSG:${datasetSrid}`,
      },
    };
  }

  return {
    dataset: datasetMeta,
    pagination: { total, page, pageSize: clampedPageSize, totalPages },
    crs: `EPSG:${datasetSrid}`,
    entities,
  };
}

/** Get a single entity from a published dataset */
export async function getPublishedEntity(
  datasetDefinitionId: string,
  entityId: string,
) {
  const release = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
    include: { activeSnapshot: true },
  });

  if (!release) return null;

  const manifest = release.activeSnapshot.manifest as unknown as ManifestItem[];
  const item = manifest.find((m) => m.entityId === entityId);
  if (!item) return null;

  const properties = (item.snapshot?.properties ?? {}) as Record<string, unknown>;
  try {
    const geos = await getEntityGeometries(entityId);
    for (const [k, v] of Object.entries(geos)) properties[k] = v;
  } catch { /* geometry from snapshot as fallback */ }

  return {
    id: item.entityId,
    type: item.type,
    version: item.versionNumber,
    properties,
  };
}

/** List models bound to a published dataset */
export async function listPublishedDatasetModels(datasetDefinitionId: string) {
  const release = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
    include: { datasetDefinition: true },
  });
  if (!release) return null;

  const bindings = await prisma.datasetModelBinding.findMany({
    where: { datasetDefinitionId },
    include: {
      modelDefinition: {
        include: { fields: true },
      },
    },
  });

  return bindings.map((b) => {
    const m = b.modelDefinition;
    const geoField = m.primaryGeometryField
      ? m.fields.find((f) => f.key === m.primaryGeometryField)
      : null;
    const srid = geoField?.geometrySrid ?? 4326;
    return {
      key: m.key,
      name: m.name,
      primaryGeometryField: m.primaryGeometryField,
      geometryType: geoField?.geometryType ?? null,
      is3D: geoField?.geometryIs3D ?? false,
      srid,
      crs: `EPSG:${srid}`,
      hasProjection: !!(b.projectionJson as any)?.fields?.length,
    };
  });
}

/** Get schema for a single model in a published dataset */
export async function getPublishedModelSchema(datasetDefinitionId: string, modelKey: string) {
  const release = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
  });
  if (!release) return null;

  const bindings = await prisma.datasetModelBinding.findMany({
    where: { datasetDefinitionId },
    include: {
      modelDefinition: {
        include: { fields: true },
      },
    },
  });
  const binding = bindings.find((b) => b.modelDefinition.key === modelKey);
  if (!binding) return null;

  const schema = await getModelSchemaById(binding.modelDefinitionId);
  if (!schema) return null;

  // Apply field projection
  const projection = binding.projectionJson as { mode: string; fields: string[] } | null;
  if (projection?.fields?.length && schema.fields) {
    if (projection.mode === "include") {
      schema.fields = schema.fields.filter((f: any) => projection.fields.includes(f.key));
    } else {
      schema.fields = schema.fields.filter((f: any) => !projection.fields.includes(f.key));
    }
  }

  // Resolve CRS from the model's primary geometry field
  const m = binding.modelDefinition;
  const geoField = m.primaryGeometryField
    ? m.fields.find((f) => f.key === m.primaryGeometryField)
    : null;
  const srid = geoField?.geometrySrid ?? 4326;

  return { ...schema, crs: `EPSG:${srid}` };
}

/** Get schema for all models bound to a published dataset */
export async function getPublishedDatasetSchema(datasetDefinitionId: string) {
  const release = await prisma.activeReleaseState.findUnique({
    where: { datasetDefinitionId },
    include: { datasetDefinition: true },
  });
  if (!release) return null;

  // Get model bindings
  const bindings = await prisma.datasetModelBinding.findMany({
    where: { datasetDefinitionId },
    include: { modelDefinition: true },
  });

  // Get schema for each bound model, applying field projection
  const models = await Promise.all(
    bindings.map(async (b) => {
      const schema = await getModelSchemaById(b.modelDefinitionId);
      if (!schema) return null;
      const projection = b.projectionJson as { mode: string; fields: string[] } | null;
      if (projection?.fields?.length && schema.fields) {
        if (projection.mode === "include") {
          schema.fields = schema.fields.filter((f: any) => projection.fields.includes(f.key));
        } else {
          schema.fields = schema.fields.filter((f: any) => !projection.fields.includes(f.key));
        }
      }
      return schema;
    }),
  );

  // If no bindings, try legacy entityTypes → find models by key (scoped to the
  // dataset's workspace, since model keys are unique only per workspace now).
  if (!models.filter(Boolean).length) {
    const entityTypes = (release.datasetDefinition.entityTypes as string[] | null) ?? [];
    const datasetWorkspaceId = release.datasetDefinition.workspaceId;
    const legacyModels = await Promise.all(
      entityTypes.map(async (key) => {
        const model = await prisma.modelDefinition.findUnique({
          where: { workspaceId_key: { workspaceId: datasetWorkspaceId, key } },
        });
        if (model) return getModelSchemaById(model.id);
        return null;
      }),
    );
    return {
      dataset: release.datasetDefinition.name,
      models: legacyModels.filter(Boolean),
    };
  }

  return {
    dataset: release.datasetDefinition.name,
    models: models.filter(Boolean),
  };
}
