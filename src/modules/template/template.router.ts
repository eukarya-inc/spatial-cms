import { Router } from "express";
import * as templateService from "./template.service.js";

export const templateRouter = Router();

// GET /api/v1/templates — list available templates
templateRouter.get("/", async (_req, res, next) => {
  try {
    const templates = templateService.listBundledTemplates();
    res.json(templates);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/templates/:id — get a single template (full content)
templateRouter.get("/:id", async (req, res, next) => {
  try {
    const template = templateService.getBundledTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json(template);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/templates/resolve — fetch + validate from URL or inline JSON
templateRouter.post("/resolve", async (req, res, next) => {
  try {
    const { url, template } = req.body;
    let resolved;
    if (url) {
      resolved = await templateService.resolveTemplateFromUrl(url);
    } else if (template) {
      resolved = template;
    } else {
      return res.status(400).json({ error: "Provide 'url' or 'template' in request body" });
    }
    res.json(resolved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/v1/templates/apply — apply a template (create models + fields)
templateRouter.post("/apply", async (req, res, next) => {
  try {
    const { template, templateId } = req.body;
    let toApply;
    if (templateId) {
      toApply = templateService.getBundledTemplate(templateId);
      if (!toApply) return res.status(404).json({ error: "Template not found" });
    } else if (template) {
      toApply = template;
    } else {
      return res.status(400).json({ error: "Provide 'templateId' or 'template' in request body" });
    }
    const result = await templateService.applyTemplate(toApply);
    res.status(201).json(result);
  } catch (err: any) {
    if (err.message?.includes("conflict")) {
      res.status(409).json({ error: err.message });
    } else {
      next(err);
    }
  }
});
