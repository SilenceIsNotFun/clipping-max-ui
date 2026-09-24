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
  review_tasks: { id: string; reason: string; status: string; created_at: string }[];
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

export interface VideoAsset {
  id: string;
  campaign_id: string;
  file_path: string;
  asset_type: "footage" | "music";
  duration_seconds: number;
  analysis_status: "pending" | "done" | "failed";
  created_at: string;
}

export interface MomentCandidate {
  id: string;
  video_asset_id: string;
  timestamp_ms: number;
  score: number;
  detection_type: "audio_peak" | "scene_change";
}

export async function uploadAsset(campaignId: string, formData: FormData): Promise<VideoAsset> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error(`asset upload failed with status ${res.status}`);
  return res.json();
}

export async function listAssets(campaignId: string): Promise<VideoAsset[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets`, { cache: "no-store" });
  if (!res.ok) throw new Error(`list assets failed with status ${res.status}`);
  return res.json();
}

export async function listMoments(campaignId: string, assetId: string): Promise<MomentCandidate[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/moments`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`list moments failed with status ${res.status}`);
  return res.json();
}
