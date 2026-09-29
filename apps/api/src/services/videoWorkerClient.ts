export interface RenderSegmentPayload {
  file_path: string;
  secondary_file_path?: string;
  trim_start: number;
  trim_end: number;
  order_index: number;
  script_text: string;
  layout_template: string;
  crop_gameplay_rect?: Record<string, number>;
  crop_facecam_rect?: Record<string, number>;
  title_text?: string;
  title_rect?: Record<string, number>;
  caption_style?: string;
  title_font?: string;
  title_color?: string;
  caption_font?: string;
  caption_rect?: Record<string, number>;
}

export async function analyzeAsset(
  videoWorkerUrl: string,
  videoAssetId: string,
  filePath: string,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_asset_id: videoAssetId, file_path: filePath, callback_url: callbackUrl }),
  });
  if (!res.ok) throw new Error(`video-worker /analyze failed with status ${res.status}`);
}

export async function submitRender(
  videoWorkerUrl: string,
  jobId: string,
  segments: RenderSegmentPayload[],
  ttsVoice: string,
  musicPath: string | null,
  watermarkPath: string | null,
  watermarkRect: Record<string, number> | null,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      segments,
      tts_voice: ttsVoice,
      music_path: musicPath,
      watermark_path: watermarkPath,
      watermark_rect: watermarkRect,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`video-worker /render failed with status ${res.status}`);
}

export async function findHooks(
  videoWorkerUrl: string,
  videoAssetId: string,
  filePath: string,
  hook: string,
  strategySummary: string,
  requirementsChecklist: string[],
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/find-hooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video_asset_id: videoAssetId,
      file_path: filePath,
      hook,
      strategy_summary: strategySummary,
      requirements_checklist: requirementsChecklist,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`video-worker /find-hooks failed with status ${res.status}`);
}

export async function triggerCut(
  videoWorkerUrl: string,
  cutJobId: string,
  filePath: string,
  startSeconds: number,
  durationSeconds: number,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/cut`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cut_job_id: cutJobId,
      file_path: filePath,
      start_seconds: startSeconds,
      duration_seconds: durationSeconds,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`video-worker /cut failed with status ${res.status}`);
}

export async function triggerYoutubeDownload(
  videoWorkerUrl: string,
  jobId: string,
  url: string,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/download-youtube`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, url, callback_url: callbackUrl }),
  });
  if (!res.ok) throw new Error(`video-worker /download-youtube failed with status ${res.status}`);
}
