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
    process.env.VIDEO_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "video-assets-"));
    jest.clearAllMocks();
  });

  it("uploads a BRD with just a title, parses, and stops at awaiting_details", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");

    const res = await request(app)
      .post("/api/campaigns")
      .field("title", "Snack Brand Reward")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("awaiting_details");
    expect(res.body.title).toBe("Snack Brand Reward");

    const listRes = await request(app).get("/api/campaigns");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);

    const detailRes = await request(app).get(`/api/campaigns/${res.body.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.plan).toBeNull();
    expect(detailRes.body.document.raw_text).toBe("Reward Campaign Brief");
  });

  it("generates a plan via POST /:id/plan once the operator supplies details", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");

    const uploaded = await request(app)
      .post("/api/campaigns")
      .field("title", "Snack Brand Reward")
      .attach("file", fixture);
    expect(uploaded.body.status).toBe("awaiting_details");

    const planned = await request(app).post(`/api/campaigns/${uploaded.body.id}/plan`).send({
      content_format: "15s vertical video",
      target_language: "id",
      deadline: "2026-10-01",
      reward: "Rp 500.000",
      constraints: "No profanity",
    });

    expect(planned.status).toBe(200);
    expect(planned.body.status).toBe("planned");

    const detailRes = await request(app).get(`/api/campaigns/${uploaded.body.id}`);
    expect(detailRes.body.plan.strategy_summary).toBe("Focus on unboxing");
  });

  it("returns 404 for POST /:id/plan on an unknown campaign", async () => {
    const app = createApp();
    const res = await request(app).post("/api/campaigns/does-not-exist/plan").send({});
    expect(res.status).toBe(404);
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
    const uploaded = await request(app)
      .post("/api/campaigns")
      .field("title", "Failing Campaign")
      .attach("file", fixture);
    expect(uploaded.body.status).toBe("awaiting_details");

    const planned = await request(app).post(`/api/campaigns/${uploaded.body.id}/plan`).send({
      content_format: "video",
      target_language: "id",
      deadline: "2026-10-01",
      reward: "500k",
      constraints: "none",
    });

    expect(planned.status).toBe(200);
    expect(planned.body.status).toBe("needs_review");
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
    const uploaded = await request(app)
      .post("/api/campaigns")
      .field("title", "Needs Review Campaign")
      .attach("file", fixture);
    expect(uploaded.body.status).toBe("awaiting_details");

    await request(app).post(`/api/campaigns/${uploaded.body.id}/plan`).send({
      content_format: "video",
      target_language: "id",
      deadline: "2026-10-01",
      reward: "500k",
      constraints: "none",
    });

    const detailRes = await request(app).get(`/api/campaigns/${uploaded.body.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.status).toBe("needs_review");
    expect(detailRes.body.review_tasks).toHaveLength(1);
    expect(detailRes.body.review_tasks[0].reason).toBe("ai-worker /plan failed with status 502");
  });

  it("returns 400 for POST /:id/plan when the campaign has no parsed document yet", async () => {
    const { parseDocument } = require("../src/services/aiWorkerClient");
    (parseDocument as jest.Mock).mockRejectedValueOnce(new Error("ai-worker /parse failed with status 502"));

    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");
    const uploaded = await request(app)
      .post("/api/campaigns")
      .field("title", "Broken Parse Campaign")
      .attach("file", fixture);
    // parseDocument rejected, so the campaign has no brd_documents row at all
    expect(uploaded.body.status).toBe("needs_review");

    const res = await request(app).post(`/api/campaigns/${uploaded.body.id}/plan`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no parsed document/i);
  });

  it("generates and downloads a PDF for a planned campaign", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "sample.pdf");
    const uploaded = await request(app)
      .post("/api/campaigns")
      .field("title", "PDF Test Campaign")
      .attach("file", fixture);

    const planned = await request(app).post(`/api/campaigns/${uploaded.body.id}/plan`).send({
      content_format: "video",
      target_language: "id",
      deadline: "2026-10-01",
      reward: "500k",
      constraints: "none",
    });
    expect(planned.body.status).toBe("planned");

    const pdfRes = await request(app).get(`/api/campaigns/${uploaded.body.id}/pdf`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers["content-type"]).toBe("application/pdf");
  });
});
