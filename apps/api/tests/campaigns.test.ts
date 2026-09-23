import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { resetDbCacheForTests } from "../src/db";

jest.mock("../src/services/aiWorkerClient", () => ({
  parseDocument: jest.fn().mockResolvedValue({
    raw_text: "Reward Campaign Brief",
    extracted_links: ["https://example.com/brief-video"],
    parsing_confidence: 0.9,
  }),
  planCampaign: jest.fn().mockResolvedValue({
    strategy_summary: "Focus on unboxing",
    requirements_checklist: ["Show product in 3s"],
    content_plan: { hook: "Surprise reveal" },
    opportunity_score: 75,
  }),
}));

describe("campaign routes", () => {
  let uploadDir: string;
  let dataDir: string;

  beforeEach(() => {
    resetDbCacheForTests();
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    process.env.UPLOAD_DIR = uploadDir;
    process.env.DATA_DIR = dataDir;
    process.env.DB_PATH = path.join(dataDir, "app.db");
    process.env.AI_WORKER_URL = "http://ai-worker:8000";
    process.env.EXPORT_DIR = path.join(dataDir, "exports");
    jest.clearAllMocks();
  });

  it("uploads a BRD, parses, plans, and returns a planned campaign", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");

    const res = await request(app)
      .post("/api/campaigns")
      .field("title", "Snack Brand Reward")
      .field("content_format", "15s vertical video")
      .field("target_language", "id")
      .field("deadline", "2026-10-01")
      .field("reward", "Rp 500.000")
      .field("constraints", "No profanity")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("planned");
    expect(res.body.title).toBe("Snack Brand Reward");

    const listRes = await request(app).get("/api/campaigns");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);

    const detailRes = await request(app).get(`/api/campaigns/${res.body.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.plan.strategy_summary).toBe("Focus on unboxing");
    expect(detailRes.body.document.raw_text).toBe("Reward Campaign Brief");
  });

  it("returns 404 for retry on unknown campaign", async () => {
    const app = createApp();
    const res = await request(app).post("/api/campaigns/does-not-exist/retry");
    expect(res.status).toBe(404);
  });

  it("marks campaign needs_review when ai-worker /plan fails", async () => {
    const { planCampaign } = require("../src/services/aiWorkerClient");
    (planCampaign as jest.Mock).mockRejectedValueOnce(new Error("ai-worker /plan failed with status 502"));

    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");
    const res = await request(app)
      .post("/api/campaigns")
      .field("title", "Failing Campaign")
      .field("content_format", "video")
      .field("target_language", "id")
      .field("deadline", "2026-10-01")
      .field("reward", "500k")
      .field("constraints", "none")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("needs_review");
  });

  it("sends Access-Control-Allow-Origin so the browser can call the api cross-origin", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "http://localhost:3000");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("returns 400 (not a crash) when title is missing, and cleans up the temp upload", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");

    const filesBefore = fs.readdirSync(uploadDir).length;
    const res = await request(app)
      .post("/api/campaigns")
      .field("content_format", "video")
      .attach("file", fixture);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    // the app must still be alive after this request (no crashed process)
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    // no orphaned temp file left behind
    expect(fs.readdirSync(uploadDir).length).toBe(filesBefore);
  });

  it("includes open review_tasks with their reason on GET /:id for a needs_review campaign", async () => {
    const { planCampaign } = require("../src/services/aiWorkerClient");
    (planCampaign as jest.Mock).mockRejectedValueOnce(new Error("ai-worker /plan failed with status 502"));

    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");
    const created = await request(app)
      .post("/api/campaigns")
      .field("title", "Needs Review Campaign")
      .field("content_format", "video")
      .field("target_language", "id")
      .field("deadline", "2026-10-01")
      .field("reward", "500k")
      .field("constraints", "none")
      .attach("file", fixture);

    expect(created.body.status).toBe("needs_review");

    const detailRes = await request(app).get(`/api/campaigns/${created.body.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.review_tasks).toHaveLength(1);
    expect(detailRes.body.review_tasks[0].reason).toBe("ai-worker /plan failed with status 502");
  });

  it("generates and downloads a PDF for a planned campaign", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");
    const created = await request(app)
      .post("/api/campaigns")
      .field("title", "PDF Test Campaign")
      .field("content_format", "video")
      .field("target_language", "id")
      .field("deadline", "2026-10-01")
      .field("reward", "500k")
      .field("constraints", "none")
      .attach("file", fixture);

    const pdfRes = await request(app).get(`/api/campaigns/${created.body.id}/pdf`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers["content-type"]).toBe("application/pdf");
  });
});
