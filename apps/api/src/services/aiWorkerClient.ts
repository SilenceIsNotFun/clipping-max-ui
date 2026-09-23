export interface ParsedDocumentResult {
  raw_text: string;
  extracted_links: string[];
  parsing_confidence: number;
}

export interface PlanInput {
  campaign_summary: string;
  requirements_text: string;
  example_links: string[];
  content_format: string;
  target_language: string;
  deadline: string;
  reward: string;
  constraints: string;
}

export interface PlanResultDto {
  strategy_summary: string;
  requirements_checklist: string[];
  content_plan: Record<string, unknown>;
  opportunity_score: number;
}

export async function parseDocument(
  aiWorkerUrl: string,
  filePath: string,
  docType: string
): Promise<ParsedDocumentResult> {
  const res = await fetch(`${aiWorkerUrl}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_path: filePath, doc_type: docType }),
  });
  if (!res.ok) throw new Error(`ai-worker /parse failed with status ${res.status}`);
  return res.json() as Promise<ParsedDocumentResult>;
}

export async function planCampaign(
  aiWorkerUrl: string,
  input: PlanInput
): Promise<PlanResultDto> {
  const res = await fetch(`${aiWorkerUrl}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`ai-worker /plan failed with status ${res.status}`);
  return res.json() as Promise<PlanResultDto>;
}
