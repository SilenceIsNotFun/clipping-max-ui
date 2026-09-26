import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import express, { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../asyncHandler";
import { getDb } from "../db";
import { parseDocument, planCampaign } from "../services/aiWorkerClient";
import { renderPlanPdf } from "../services/pdfExport";

function docTypeFromMime(mime: string): "pdf" | "docx" | "image" | null {
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return "docx";
  if (mime.startsWith("image/")) return "image";
  return null;
}

export function createCampaignsRouter(): Router {
  const router = express.Router();
  const uploadDir = process.env.UPLOAD_DIR ?? "/app/uploads";
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";
  const aiWorkerUrl = process.env.AI_WORKER_URL ?? "http://ai-worker:8000";
  fs.mkdirSync(uploadDir, { recursive: true });

  const upload = multer({ dest: uploadDir, limits: { fileSize: 50 * 1024 * 1024 } });

  router.post("/", upload.single("file"), asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const docType = docTypeFromMime(file.mimetype);
    if (!docType) {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: `unsupported file type: ${file.mimetype}` });
      return;
    }
    if (!req.body.title || !String(req.body.title).trim()) {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: "title is required" });
      return;
    }

    const finalPath = path.join(uploadDir, `${file.filename}${path.extname(file.originalname)}`);
    fs.renameSync(file.path, finalPath);

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, req.body.title, "parsing", finalPath, now, now);

    await runParse(id, finalPath, docType, aiWorkerUrl, dbPath);

    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
    res.status(201).json(campaign);
  }));

  router.post("/:id/plan", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as
      | { id: string }
      | undefined;
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const document = db
      .prepare("SELECT * FROM brd_documents WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.id) as { raw_text: string; extracted_links: string } | undefined;
    if (!document) {
      res.status(400).json({ error: "campaign has no parsed document yet" });
      return;
    }
    await runPlan(req.params.id, document, req.body, aiWorkerUrl, dbPath);
    const updated = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id);
    res.json(updated);
  }));

  router.get("/", (_req, res) => {
    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all();
    res.json(rows);
  });

  router.get("/:id", (req, res) => {
    const db = getDb(dbPath);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const document = db
      .prepare("SELECT * FROM brd_documents WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.id) as any;
    const plan = db
      .prepare("SELECT * FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.id) as any;
    const reviewTasks = db
      .prepare(
        "SELECT * FROM review_tasks WHERE campaign_id = ? AND status = 'open' ORDER BY created_at DESC"
      )
      .all(req.params.id);
    res.json({
      ...campaign,
      document: document
        ? { ...document, extracted_links: JSON.parse(document.extracted_links) }
        : null,
      plan: plan
        ? {
            ...plan,
            requirements_checklist: JSON.parse(plan.requirements_checklist),
            content_plan: JSON.parse(plan.content_plan),
          }
        : null,
      review_tasks: reviewTasks,
    });
  });

  router.post("/:id/retry", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as
      | { id: string; source_file_path: string }
      | undefined;
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const ext = path.extname(campaign.source_file_path).replace(".", "");
    const docType = ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : "image";
    await runParse(campaign.id, campaign.source_file_path, docType, aiWorkerUrl, dbPath);
    const afterParse = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaign.id) as {
      status: string;
    };
    if (afterParse.status === "awaiting_details") {
      const document = db
        .prepare("SELECT * FROM brd_documents WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(campaign.id) as { raw_text: string; extracted_links: string };
      await runPlan(campaign.id, document, req.body, aiWorkerUrl, dbPath);
    }
    const updated = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaign.id);
    res.json(updated);
  }));

  router.get("/:id/pdf", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id) as any;
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const plan = db
      .prepare("SELECT * FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.id) as any;
    if (!plan) {
      res.status(404).json({ error: "no plan available for this campaign" });
      return;
    }
    const exportDir = process.env.EXPORT_DIR ?? "/app/data/exports";
    fs.mkdirSync(exportDir, { recursive: true });
    const outputPath = plan.pdf_path ?? path.join(exportDir, `${plan.id}.pdf`);

    if (!fs.existsSync(outputPath)) {
      const document = db
        .prepare("SELECT * FROM brd_documents WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(req.params.id) as any;
      await renderPlanPdf(
        {
          campaignTitle: campaign.title,
          strategySummary: plan.strategy_summary,
          requirementsChecklist: JSON.parse(plan.requirements_checklist),
          contentPlan: JSON.parse(plan.content_plan),
          opportunityScore: plan.opportunity_score,
          exampleLinks: document ? JSON.parse(document.extracted_links) : [],
        },
        outputPath
      );
      db.prepare("UPDATE plans SET pdf_path = ? WHERE id = ?").run(outputPath, plan.id);
    }

    res.download(outputPath, `${campaign.title.replace(/\s+/g, "_")}.pdf`);
  }));

  return router;
}

async function runParse(
  campaignId: string,
  filePath: string,
  docType: "pdf" | "docx" | "image",
  aiWorkerUrl: string,
  dbPath: string
): Promise<void> {
  const db = getDb(dbPath);
  const now = new Date().toISOString();
  try {
    const parsed = await parseDocument(aiWorkerUrl, filePath, docType);
    db.prepare(
      `INSERT INTO brd_documents (id, campaign_id, doc_type, raw_text, extracted_links, parsing_confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      campaignId,
      docType,
      parsed.raw_text,
      JSON.stringify(parsed.extracted_links),
      parsed.parsing_confidence,
      now
    );

    if (parsed.parsing_confidence < 0.5) {
      db.prepare(
        `INSERT INTO review_tasks (id, campaign_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), campaignId, "low parsing confidence", "open", now);
      db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(
        "needs_review",
        now,
        campaignId
      );
      return;
    }

    // Parsing succeeded: stop here and wait for the operator to supply
    // content_format/target_language/deadline/reward/constraints via
    // POST /:id/plan, rather than generating a plan immediately with
    // whatever the upload form happened to carry.
    db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(
      "awaiting_details",
      now,
      campaignId
    );
  } catch (err) {
    db.prepare(
      `INSERT INTO review_tasks (id, campaign_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), campaignId, (err as Error).message, "open", now);
    db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(
      "needs_review",
      now,
      campaignId
    );
  }
}

async function runPlan(
  campaignId: string,
  document: { raw_text: string; extracted_links: string },
  body: Record<string, string>,
  aiWorkerUrl: string,
  dbPath: string
): Promise<void> {
  const db = getDb(dbPath);
  const now = new Date().toISOString();
  try {
    const extractedLinks = JSON.parse(document.extracted_links);
    const plan = await planCampaign(aiWorkerUrl, {
      campaign_summary: document.raw_text.slice(0, 500),
      requirements_text: document.raw_text,
      example_links: extractedLinks,
      content_format: body.content_format ?? "",
      target_language: body.target_language ?? "",
      deadline: body.deadline ?? "",
      reward: body.reward ?? "",
      constraints: body.constraints ?? "",
    });

    db.prepare(
      `INSERT INTO plans (id, campaign_id, strategy_summary, requirements_checklist, content_plan, opportunity_score, pdf_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      campaignId,
      plan.strategy_summary,
      JSON.stringify(plan.requirements_checklist),
      JSON.stringify(plan.content_plan),
      plan.opportunity_score,
      null,
      now
    );

    db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(
      "planned",
      now,
      campaignId
    );
  } catch (err) {
    db.prepare(
      `INSERT INTO review_tasks (id, campaign_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), campaignId, (err as Error).message, "open", now);
    db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(
      "needs_review",
      now,
      campaignId
    );
  }
}
