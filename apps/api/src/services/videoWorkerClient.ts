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
  caption_style?: string;
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
