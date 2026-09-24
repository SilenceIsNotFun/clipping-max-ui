export type CampaignStatus =
  | "uploaded"
  | "parsing"
  | "planned"
  | "needs_review"
  | "failed";

export interface Campaign {
  id: string;
  title: string;
  status: CampaignStatus;
  source_file_path: string;
  created_at: string;
  updated_at: string;
}

export interface BrdDocument {
  id: string;
  campaign_id: string;
  doc_type: "pdf" | "docx" | "image";
  raw_text: string;
  extracted_links: string; // JSON-encoded string[]
  parsing_confidence: number;
  created_at: string;
}

export interface Plan {
  id: string;
  campaign_id: string;
  strategy_summary: string;
  requirements_checklist: string; // JSON-encoded string[]
  content_plan: string; // JSON-encoded object
  opportunity_score: number;
  pdf_path: string | null;
  created_at: string;
}

export interface ReviewTask {
  id: string;
  campaign_id: string;
  reason: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
}
