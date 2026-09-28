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
      null,
      null,
      "http://api:4000/api/internal/render/job-1/complete"
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://video-worker:8100/render",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("submitRender includes watermark_path and watermark_rect when provided", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await submitRender(
      "http://video-worker:8100",
      "job-1",
      [],
      "id_ID-news_tts-medium",
      null,
      "/app/video-assets/logo.png",
      { x: 0.7, y: 0.05, width: 0.25, height: 0.1 },
      "http://cb"
    );

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.watermark_path).toBe("/app/video-assets/logo.png");
    expect(body.watermark_rect).toEqual({ x: 0.7, y: 0.05, width: 0.25, height: 0.1 });
  });

  it("submitRender sends null watermark fields when not provided", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await submitRender("http://video-worker:8100", "job-1", [], "id_ID-news_tts-medium", null, null, null, "http://cb");

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.watermark_path).toBeNull();
    expect(body.watermark_rect).toBeNull();
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

  it("triggerCut posts the expected body to video-worker's /cut", async () => {
    const { triggerCut } = require("../src/services/videoWorkerClient");
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true }) as any;

    await triggerCut(
      "http://video-worker:8100",
      "job-1",
      "/app/video-assets/source.mp4",
      10,
      5,
      "http://api:4000/api/internal/cut-jobs/job-1/complete"
    );

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("http://video-worker:8100/cut");
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      cut_job_id: "job-1",
      file_path: "/app/video-assets/source.mp4",
      start_seconds: 10,
      duration_seconds: 5,
      callback_url: "http://api:4000/api/internal/cut-jobs/job-1/complete",
    });
  });

  it("triggerCut throws when video-worker responds with a non-ok status", async () => {
    const { triggerCut } = require("../src/services/videoWorkerClient");
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 500 }) as any;

    await expect(
      triggerCut("http://video-worker:8100", "job-1", "/app/video-assets/source.mp4", 10, 5, "http://cb")
    ).rejects.toThrow("video-worker /cut failed with status 500");
  });

  it("triggerYoutubeDownload posts the expected body to video-worker's /download-youtube", async () => {
    const { triggerYoutubeDownload } = require("../src/services/videoWorkerClient");
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true }) as any;

    await triggerYoutubeDownload(
      "http://video-worker:8100",
      "job-1",
      "https://youtube.com/watch?v=x",
      "http://api:4000/api/internal/youtube-jobs/job-1/progress"
    );

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("http://video-worker:8100/download-youtube");
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      job_id: "job-1",
      url: "https://youtube.com/watch?v=x",
      callback_url: "http://api:4000/api/internal/youtube-jobs/job-1/progress",
    });
  });

  it("triggerYoutubeDownload throws when video-worker responds with a non-ok status", async () => {
    const { triggerYoutubeDownload } = require("../src/services/videoWorkerClient");
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 500 }) as any;

    await expect(
      triggerYoutubeDownload("http://video-worker:8100", "job-1", "https://youtube.com/watch?v=x", "http://cb")
    ).rejects.toThrow("video-worker /download-youtube failed with status 500");
  });
});
