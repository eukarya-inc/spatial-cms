import prisma from "../db/client.js";

interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate entity data against a ModelDefinition's field definitions.
 * Returns { valid: true, errors: [] } if no ModelDefinition exists (backward compat).
 */
export async function validateAgainstModel(
  modelDefinitionId: string | null | undefined,
  properties: Record<string, unknown>,
): Promise<ValidationResult> {
  if (!modelDefinitionId) return { valid: true, errors: [] };

  const model = await prisma.modelDefinition.findUnique({
    where: { id: modelDefinitionId },
    include: { fields: { orderBy: { orderIndex: "asc" } } },
  });

  if (!model) return { valid: true, errors: [] };

  const errors: string[] = [];

  // Validate each field
  for (const field of model.fields) {
    const value = properties[field.key];
    const isPresent = value !== undefined && value !== null;

    // Required check
    if (field.isRequired && !isPresent) {
      errors.push(`Field "${field.key}" is required`);
      continue;
    }

    if (!isPresent) continue;

    // Type check
    switch (field.fieldType) {
      case "string":
        if (typeof value !== "string") {
          errors.push(`Field "${field.key}" must be a string`);
        } else {
          const rules = field.validationJson as {
            minLength?: number;
            maxLength?: number;
            pattern?: string;
          } | null;
          if (rules?.minLength && value.length < rules.minLength)
            errors.push(`Field "${field.key}" must be at least ${rules.minLength} characters`);
          if (rules?.maxLength && value.length > rules.maxLength)
            errors.push(`Field "${field.key}" must be at most ${rules.maxLength} characters`);
          if (rules?.pattern && !new RegExp(rules.pattern).test(value))
            errors.push(`Field "${field.key}" does not match pattern ${rules.pattern}`);
        }
        break;

      case "number":
        if (typeof value !== "number") {
          errors.push(`Field "${field.key}" must be a number`);
        } else {
          const rules = field.validationJson as {
            min?: number;
            max?: number;
          } | null;
          if (rules?.min !== undefined && value < rules.min)
            errors.push(`Field "${field.key}" must be >= ${rules.min}`);
          if (rules?.max !== undefined && value > rules.max)
            errors.push(`Field "${field.key}" must be <= ${rules.max}`);
        }
        break;

      case "boolean":
        if (typeof value !== "boolean")
          errors.push(`Field "${field.key}" must be a boolean`);
        break;

      case "date":
        if (typeof value !== "string" || isNaN(Date.parse(value)))
          errors.push(`Field "${field.key}" must be a valid date string`);
        break;

      case "enum_": {
        const allowed = field.enumValues as string[] | null;
        if (!allowed || !allowed.includes(value as string))
          errors.push(`Field "${field.key}" must be one of: ${(allowed ?? []).join(", ")}`);
        break;
      }

      case "reference":
        if (typeof value !== "string")
          errors.push(`Field "${field.key}" must be a UUID string`);
        break;

      case "json":
        // Any value is valid
        break;

      case "geometry": {
        const geo = value as GeoJsonGeometry;
        if (!geo.type || !geo.coordinates) {
          errors.push(`Field "${field.key}" must be a valid GeoJSON geometry (requires "type" and "coordinates")`);
        } else if (field.geometryType && field.geometryType !== "NONE") {
          validateGeometryType(field.geometryType, field.key, geo, errors);
        }
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateGeometryType(
  geometryType: string,
  fieldKey: string,
  geometry: GeoJsonGeometry,
  errors: string[],
) {
  switch (geometryType) {
    case "POINT":
      if (geometry.type !== "Point" && geometry.type !== "MultiPoint")
        errors.push(`Field "${fieldKey}" must be Point or MultiPoint, got ${geometry.type}`);
      break;
    case "LINESTRING":
      if (geometry.type !== "LineString" && geometry.type !== "MultiLineString")
        errors.push(`Field "${fieldKey}" must be LineString or MultiLineString, got ${geometry.type}`);
      break;
    case "POLYGON":
      if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
        errors.push(`Field "${fieldKey}" must be Polygon or MultiPolygon, got ${geometry.type}`);
      break;
    case "MIXED":
      // Any geometry type is fine
      break;
  }
}

/**
 * Look up ModelDefinition by key, scoped to a workspace.
 * (Model keys are unique per workspace, not globally.)
 */
export async function findModelDefinitionByKey(workspaceId: string, key: string) {
  return prisma.modelDefinition.findUnique({
    where: { workspaceId_key: { workspaceId, key } },
  });
}
