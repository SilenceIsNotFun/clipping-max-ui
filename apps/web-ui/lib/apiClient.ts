export interface Campaign {
  id: string;
  title: string;
  status: "uploaded" | "parsing" | "awaiting_details" | "planned" | "needs_review" | "failed";
  source_file_path: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignPlanDetails {
  content_format: string;
  target_language: string;
  deadline: string;
  reward: string;
  constraints: string;
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

export async function planCampaign(id: string, details: CampaignPlanDetails): Promise<Campaign> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${id}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(details),
  });
  if (!res.ok) throw new Error(`generate plan failed with status ${res.status}`);
  return res.json();
}

export async function retryCampaign(id: string, details: CampaignPlanDetails): Promise<Campaign> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${id}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(details),
  });
  if (!res.ok) throw new Error(`retry failed with status ${res.status}`);
  return res.json();
}

export interface VideoAsset {
  id: string;
  campaign_id: string;
  file_path: string;
  asset_type: "footage" | "music";
  duration_seconds: number;
  analysis_status: "pending" | "done" | "failed";
  hook_status: "none" | "pending" | "done" | "failed";
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

export async function deleteAsset(campaignId: string, assetId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    if (res.status === 409) throw new Error("This asset is used in a segment — remove it from segments first.");
    throw new Error(`delete asset failed with status ${res.status}`);
  }
}

export async function listMoments(campaignId: string, assetId: string): Promise<MomentCandidate[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/moments`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`list moments failed with status ${res.status}`);
  return res.json();
}

export type LayoutTemplate =
  | "standard"
  | "gameplay_facecam_split"
  | "gameplay_full_focus"
  | "cinematic_letterbox";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SegmentDraft {
  segment_key: string;
  video_asset_id: string;
  secondary_video_asset_id?: string;
  trim_start: number;
  trim_end: number;
  order_index: number;
  layout_template: LayoutTemplate;
  crop_gameplay_rect?: CropRect;
  crop_facecam_rect?: CropRect;
  title_text?: string;
  caption_style?: string;
}

export async function saveSegments(campaignId: string, segments: SegmentDraft[]): Promise<unknown> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/segments`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(JSON.stringify(body));
  }
  return res.json();
}

export interface CropSuggestion {
  crop_gameplay_rect: string | null;
  crop_facecam_rect: string | null;
  detection_method: "face" | "saliency";
  confidence: number;
}

export async function getCropSuggestion(campaignId: string, assetId: string): Promise<CropSuggestion | null> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/crop-suggestion`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get crop suggestion failed with status ${res.status}`);
  return res.json();
}

export interface HookSuggestion {
  id: string;
  video_asset_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  reasoning: string;
  created_at: string;
}

export async function findHooks(campaignId: string, assetId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/find-hooks`, {
    method: "POST",
  });
  if (!res.ok) {
    if (res.status === 400) {
      const body = await res.json();
      throw new Error(body.error ?? "find hooks failed: campaign has no plan yet");
    }
    throw new Error(`find hooks failed with status ${res.status}`);
  }
}

export async function getHookSuggestions(campaignId: string, assetId: string): Promise<HookSuggestion[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/hook-suggestions`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get hook suggestions failed with status ${res.status}`);
  return res.json();
}

export async function submitRenderJob(
  campaignId: string,
  ttsVoice: string,
  musicAssetId?: string
): Promise<{ job_id: string; status: string }> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tts_voice: ttsVoice, music_asset_id: musicAssetId }),
  });
  if (!res.ok) throw new Error(`render submit failed with status ${res.status}`);
  return res.json();
}

export interface RenderJobDetail {
  id: string;
  campaign_id: string;
  status: "queued" | "rendering" | "ready_for_preview" | "final" | "failed";
  tts_voice: string;
  music_asset_id: string | null;
  output_path: string | null;
  error_message: string | null;
}

export async function getRenderJob(campaignId: string, jobId: string): Promise<RenderJobDetail> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/render/${jobId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get render job failed with status ${res.status}`);
  return res.json();
}

export async function finalizeRenderJob(campaignId: string, jobId: string): Promise<RenderJobDetail> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/render/${jobId}/finalize`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`finalize failed with status ${res.status}`);
  return res.json();
}
