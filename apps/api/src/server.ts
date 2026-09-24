import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { createCampaignsRouter } from "./routes/campaigns";
import { createAssetsRouter } from "./routes/assets";
import { createInternalRouter } from "./routes/internal";

export function createApp() {
  const app = express();
  // Wide-open CORS is acceptable here: this is a single-operator local tool,
  // not a multi-tenant service, and the web-ui talks to the api cross-origin.
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/campaigns", createCampaignsRouter());
  app.use("/api/campaigns/:id/assets", createAssetsRouter());
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
