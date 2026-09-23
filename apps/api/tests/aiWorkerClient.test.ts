import { parseDocument, planCampaign } from "../src/services/aiWorkerClient";

describe("aiWorkerClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("parseDocument posts file_path and doc_type, returns parsed result", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        raw_text: "hello",
        extracted_links: ["https://x.com"],
        parsing_confidence: 0.9,
      }),
    }) as any;

    const result = await parseDocument("http://ai-worker:8000", "/uploads/a.pdf", "pdf");

    expect(result.raw_text).toBe("hello");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://ai-worker:8000/parse",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ file_path: "/uploads/a.pdf", doc_type: "pdf" }),
      })
    );
  });

  it("planCampaign posts plan input, returns plan result", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        strategy_summary: "s",
        requirements_checklist: ["a"],
        content_plan: { hook: "h" },
        opportunity_score: 80,
      }),
    }) as any;

    const result = await planCampaign("http://ai-worker:8000", {
      campaign_summary: "sum",
      requirements_text: "req",
      example_links: [],
      content_format: "video",
      target_language: "id",
      deadline: "2026-10-01",
      reward: "500k",
      constraints: "none",
    });

    expect(result.opportunity_score).toBe(80);
  });

  it("throws when ai-worker responds with non-ok status", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 }) as any;
    await expect(
      parseDocument("http://ai-worker:8000", "/uploads/a.pdf", "pdf")
    ).rejects.toThrow("ai-worker /parse failed with status 400");
  });
});
