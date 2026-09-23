export interface Campaign {
  id: string;
  title: string;
  status: "uploaded" | "parsing" | "planned" | "needs_review" | "failed";
  source_file_path: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignDetail extends Campaign {
  document: {
    raw_text: string;
    extracted_links: string[];
    parsing_confidence: number;
  } | null;
  plan: {
    strategy_summary: string;
    requirements_checklist: string[];
    content_plan: Record<string, unknown>;
    opportunity_score: number;
  } | null;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export async function uploadCampaign(formData: FormData): Promise<Campaign> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns`, { method: "POST", body: formData });
  if (!res.ok) throw new Error(`upload failed with status ${res.status}`);
  return res.json();
}

export async function listCampaigns(): Promise<Campaign[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns`, { cache: "no-store" });
  if (!res.ok) throw new Error(`list failed with status ${res.status}`);
  return res.json();
}

export async function getCampaign(id: string): Promise<CampaignDetail> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`get campaign failed with status ${res.status}`);
  return res.json();
}
