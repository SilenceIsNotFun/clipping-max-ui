import { analyzeAsset, submitRender, findHooks } from "../src/services/videoWorkerClient";

describe("videoWorkerClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("analyzeAsset posts to /analyze with callback_url", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await analyzeAsset(
      "http://video-worker:8100",
      "asset-1",
      "/video-assets/a.mp4",
      "http://api:4000/api/internal/assets/asset-1/analysis-complete"
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://video-worker:8100/analyze",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          video_asset_id: "asset-1",
          file_path: "/video-assets/a.mp4",
          callback_url: "http://api:4000/api/internal/assets/asset-1/analysis-complete",
        }),
      })
    );
  });

  it("submitRender posts to /render with segments and callback_url", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await submitRender(
      "http://video-worker:8100",
      "job-1",
      [{ file_path: "/a.mp4", trim_start: 0, trim_end: 1, order_index: 0, script_text: "hi", layout_template: "standard" }],
      "id_ID-voice-medium",
      null,
      "http://api:4000/api/internal/render/job-1/complete"
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://video-worker:8100/render",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws when video-worker responds with non-ok status", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    await expect(
      analyzeAsset("http://video-worker:8100", "asset-1", "/a.mp4", "http://cb")
    ).rejects.toThrow("video-worker /analyze failed with status 500");
  });

  it("findHooks posts video/BRD context to /find-hooks", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await findHooks(
      "http://video-worker:8100",
      "asset-1",
      "/app/video-assets/clip.mp4",
      "lead with the prize",
      "fast cuts",
      ["30-59 seconds"],
      "http://api:4000/api/internal/assets/asset-1/hooks-complete"
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://video-worker:8100/find-hooks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          video_asset_id: "asset-1",
          file_path: "/app/video-assets/clip.mp4",
          hook: "lead with the prize",
          strategy_summary: "fast cuts",
          requirements_checklist: ["30-59 seconds"],
          callback_url: "http://api:4000/api/internal/assets/asset-1/hooks-complete",
        }),
      })
    );
  });

  it("findHooks throws when video-worker responds with a non-ok status", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;

    await expect(
      findHooks("http://video-worker:8100", "asset-1", "/path.mp4", "h", "s", [], "http://cb")
    ).rejects.toThrow("video-worker /find-hooks failed with status 500");
  });
});
