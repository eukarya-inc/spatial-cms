import { Router } from "express";
import * as proposalService from "./proposal.service.js";

export const proposalRouter = Router();

// POST /api/v1/proposals
proposalRouter.post("/", async (req, res, next) => {
  try {
    const proposal = await proposalService.createProposal(req.body);
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
    const proposal = await proposalService.getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    res.json(proposal);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/proposals/:id/approve
proposalRouter.post("/:id/approve", async (req, res, next) => {
  try {
    const result = await proposalService.approveProposal(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/proposals/:id/reject
proposalRouter.post("/:id/reject", async (req, res, next) => {
  try {
    const result = await proposalService.rejectProposal(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
