import fs from "fs";
import PDFDocument from "pdfkit";

export interface PlanPdfInput {
  campaignTitle: string;
  strategySummary: string;
  requirementsChecklist: string[];
  contentPlan: Record<string, unknown>;
  opportunityScore: number;
  exampleLinks: string[];
}

export function renderPlanPdf(input: PlanPdfInput, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(18).text(input.campaignTitle);
    doc.moveDown();
    doc.fontSize(14).text("Strategy Summary");
    doc.fontSize(11).text(input.strategySummary);
    doc.moveDown();

    doc.fontSize(14).text("Requirements Checklist");
    input.requirementsChecklist.forEach((item) => doc.fontSize(11).text(`- ${item}`));
    doc.moveDown();

    doc.fontSize(14).text("Content Plan");
    doc.fontSize(11).text(JSON.stringify(input.contentPlan, null, 2));
    doc.moveDown();

    doc.fontSize(14).text(`Opportunity Score: ${input.opportunityScore}`);
    doc.moveDown();

    doc.fontSize(14).text("Example Links");
    input.exampleLinks.forEach((link) => doc.fontSize(11).text(link));

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}
