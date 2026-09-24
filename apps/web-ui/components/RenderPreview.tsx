"use client";

import { useState } from "react";
import { RenderJobDetail, finalizeRenderJob, submitRenderJob } from "../lib/apiClient";
import { useRouter } from "next/navigation";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function RenderPreview({ campaignId, job }: { campaignId: string; job: RenderJobDetail }) {
  const router = useRouter();
  const [voice, setVoice] = useState(job.tts_voice);
  const [finalizing, setFinalizing] = useState(false);

  async function handleReRender() {
    const newJob = await submitRenderJob(campaignId, voice, job.music_asset_id ?? undefined);
    router.push(`/campaigns/${campaignId}/preview/${newJob.job_id}`);
  }

  async function handleFinalize() {
    setFinalizing(true);
    await finalizeRenderJob(campaignId, job.id);
    setFinalizing(false);
    router.refresh();
  }

  if (job.status === "failed") {
    return <p role="alert">Render failed: {job.error_message}</p>;
  }
  if (job.status !== "ready_for_preview" && job.status !== "final") {
    return <p>Rendering... ({job.status})</p>;
  }

  return (
    <div>
      <video src={`${API_BASE_URL}/media${job.output_path?.replace("/app/video-assets", "")}`} controls />
      <p>Status: {job.status}</p>
      <input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="TTS voice" />
      <button type="button" onClick={handleReRender}>
        Re-render with new voice
      </button>
      {job.status !== "final" && (
        <button type="button" onClick={handleFinalize} disabled={finalizing}>
          Finalize
        </button>
      )}
    </div>
  );
}
