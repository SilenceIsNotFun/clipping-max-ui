import fs from "fs";
import os from "os";
import path from "path";
import { renderPlanPdf } from "../src/services/pdfExport";

describe("renderPlanPdf", () => {
  it("writes a non-empty PDF file", async () => {
    const outputPath = path.join(os.tmpdir(), `plan-${Date.now()}.pdf`);
    await renderPlanPdf(
      {
        campaignTitle: "Snack Brand Reward",
        strategySummary: "Focus on unboxing",
        requirementsChecklist: ["Show product in 3s"],
        contentPlan: { hook: "Surprise reveal", script: "..." },
        opportunityScore: 75,
        exampleLinks: ["https://example.com/brief-video"],
      },
      outputPath
    );

    expect(fs.existsSync(outputPath)).toBe(true);
    const header = fs.readFileSync(outputPath, { encoding: "latin1", flag: "r" }).slice(0, 5);
    expect(header).toBe("%PDF-");
    fs.unlinkSync(outputPath);
  });
});
