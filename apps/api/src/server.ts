import express from "express";
import { createCampaignsRouter } from "./routes/campaigns";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/campaigns", createCampaignsRouter());

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`api listening on ${port}`));
}
