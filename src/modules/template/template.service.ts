import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../../db/client.js";
import {
  createModelDefinition,
  addField,
} from "../definition/definition.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "../../templates");

interface TemplateField {
  key: string;
  label: string;
  fieldType: string;
  isRequired?: boolean;
  defaultValue?: unknown;
  enumValues?: string[];
  validationJson?: object;
  referenceModelKey?: string;
  orderIndex?: number;
}

interface TemplateModel {
  key: string;
  name: string;
  description?: string;
  geometryType?: string;
  is3D?: boolean;
  srid?: number;
  displayField?: string;
  governance?: { approvalMode?: string; publishMode?: string };
  fields: TemplateField[];
}

interface Template {
  templateVersion: string;
  metadata: {
    name: string;
    description?: string;
    author?: string;
    license?: string;
    tags?: string[];
  };
  models: TemplateModel[];
  dataset?: {
    name: string;
    description?: string;
    license?: string;
    publishToDelivery?: boolean;
    publishToOgc?: boolean;
  };
}

/** List all bundled templates (metadata only) */
export function listBundledTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf-8")) as Template;
      return {
        id: file.replace(".json", ""),
        file,
        ...raw.metadata,
        modelCount: raw.models.length,
        fieldCount: raw.models.reduce((s, m) => s + m.fields.length, 0),
        hasDataset: !!raw.dataset,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** Get a single bundled template by ID */
export function getBundledTemplate(id: string): Template | null {
  const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Template;
  } catch {
    return null;
  }
}

/** Fetch and parse a template from a URL */
export async function resolveTemplateFromUrl(url: string): Promise<Template> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Failed to fetch template: ${res.status}`);
  const text = await res.text();
  if (text.length > 1_000_000) throw new Error("Template too large (max 1MB)");
  return JSON.parse(text) as Template;
}

/** Apply a template: create models, fields, governance, optionally dataset */
export async function applyTemplate(
  template: Template,
  overrides?: Record<string, { key?: string; name?: string }>,
) {
  // Apply key/name overrides
  const models = template.models.map((m) => {
    const ovr = overrides?.[m.key];
    return { ...m, key: ovr?.key || m.key, name: ovr?.name || m.name };
  });

  // Check for key conflicts
  const existingModels = await prisma.modelDefinition.findMany({ select: { key: true } });
  const existingKeys = new Set(existingModels.map((m) => m.key));
  const conflicts = models.filter((m) => existingKeys.has(m.key)).map((m) => m.key);
  if (conflicts.length) {
    throw new Error(`Model key conflict: ${conflicts.join(", ")} already exist`);
  }

  const createdModels: Array<{ id: string; key: string; name: string; fieldCount: number }> = [];

  for (const tm of models) {
    // Create model
    const model = await createModelDefinition({
      key: tm.key,
      name: tm.name,
      description: tm.description,
      geometryType: (tm.geometryType as any) ?? "NONE",
      is3D: tm.is3D ?? false,
      srid: tm.srid ?? 4326,
      displayField: tm.displayField,
    });

    // Create fields
    for (const tf of tm.fields) {
      await addField(model.id, {
        key: tf.key,
        label: tf.label,
        fieldType: tf.fieldType,
        isRequired: tf.isRequired ?? false,
        defaultValue: tf.defaultValue,
        enumValues: tf.enumValues,
        validationJson: tf.validationJson,
        referenceModelKey: tf.referenceModelKey,
        orderIndex: tf.orderIndex ?? 0,
      });
    }

    // Override governance if specified
    if (tm.governance?.approvalMode && tm.governance.approvalMode !== "manual") {
      await prisma.governancePolicy.updateMany({
        where: { targetType: "model", targetId: model.id },
        data: {
          approvalMode: tm.governance.approvalMode as any,
          publishMode: (tm.governance.publishMode as any) ?? "manual",
        },
      });
    }

    createdModels.push({ id: model.id, key: model.key, name: tm.name, fieldCount: tm.fields.length });
  }

  // Create dataset if specified
  let datasetId: string | null = null;
  if (template.dataset) {
    const ds = await prisma.datasetDefinition.create({
      data: {
        name: template.dataset.name,
        description: template.dataset.description,
        license: template.dataset.license,
        entityTypes: [] as any,
        publishToDelivery: template.dataset.publishToDelivery ?? true,
        publishToOgc: template.dataset.publishToOgc ?? false,
      },
    });
    datasetId = ds.id;

    // Bind all created models to the dataset
    for (const cm of createdModels) {
      await prisma.datasetModelBinding.create({
        data: { datasetDefinitionId: ds.id, modelDefinitionId: cm.id },
      });
    }
  }

  return {
    models: createdModels,
    datasetId,
    templateName: template.metadata.name,
  };
}
