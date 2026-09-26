import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { createCampaignsRouter } from "./routes/campaigns";
import { createAssetsRouter } from "./routes/assets";
import { createInternalRouter } from "./routes/internal";
import { createSegmentsRouter } from "./routes/segments";
import { createRenderRouter } from "./routes/render";

export function createApp() {
  const app = express();
  // Wide-open CORS is acceptable here: this is a single-operator local tool,
  // not a multi-tenant service, and the web-ui talks to the api cross-origin.
  app.use(cors());
  // Default 100kb is too small for the analysis-complete callback on long
  // source videos: a multi-hour VOD can produce thousands of moment
  // candidates, well past the default limit (confirmed in practice: a
  // ~440KB payload was silently rejected with a 413, leaving the asset
  // stuck at "pending" forever since video-worker never checked the
  // response status of that callback).
  app.use(express.json({ limit: "25mb" }));
  app.use("/media", express.static(process.env.VIDEO_ASSETS_DIR ?? "/app/video-assets"));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/campaigns", createCampaignsRouter());
  app.use("/api/campaigns/:id/assets", createAssetsRouter());
  app.use("/api/campaigns/:id/segments", createSegmentsRouter());
  app.use("/api/campaigns/:id/render", createRenderRouter());
  app.use("/api/internal", createInternalRouter());

  // Error-handling middleware must be registered last, with 4 args, so
  // Express recognizes it as an error handler. This prevents an error
  // forwarded via next(err) (e.g. from asyncHandler) from crashing the
  // process, and instead returns a clean 500 response.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`api listening on ${port}`));
}
