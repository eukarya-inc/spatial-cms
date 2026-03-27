import { Router } from "express";
import * as proposalService from "./proposal.service.js";
import {
  createProposalSchema,
  uuidParamSchema,
} from "../../shared/validation.js";

export const proposalRouter = Router();

// POST /api/v1/proposals
proposalRouter.post("/", async (req, res, next) => {
  try {
    const data = createProposalSchema.parse(req.body);
    const proposal = await proposalService.createProposal(data);
    res.status(201).json(proposal);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/proposals
proposalRouter.get("/", async (req, res, next) => {
  try {
    const proposals = await proposalService.listProposals({
      status: req.query.status as string | undefined,
    });
    res.json(proposals);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/proposals/:id
proposalRouter.get("/:id", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const proposal = await proposalService.getProposal(id);
    if (!proposal)
      return res.status(404).json({ error: "Proposal not found" });
    res.json(proposal);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/proposals/:id/approve
proposalRouter.post("/:id/approve", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const result = await proposalService.approveProposal(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/proposals/:id/reject
proposalRouter.post("/:id/reject", async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const result = await proposalService.rejectProposal(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
