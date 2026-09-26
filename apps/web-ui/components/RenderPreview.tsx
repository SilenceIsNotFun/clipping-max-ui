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
    return (
      <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        <p className="font-semibold">Render failed</p>
        <p className="mt-1">{job.error_message}</p>
      </div>
    );
  }
  if (job.status !== "ready_for_preview" && job.status !== "final") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-700">
        <span className="h-3 w-3 animate-pulse rounded-full bg-amber-500" />
        <p className="text-sm font-medium">Rendering... ({job.status})</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm">
      <video
        src={`${API_BASE_URL}/media${job.output_path?.replace("/app/video-assets", "")}`}
        controls
        className="w-full rounded-xl bg-black"
      />
      <span className="w-fit rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
        {job.status}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
        >
          <option value="id_ID-news_tts-medium">Indonesian (news, medium)</option>
          <option value="en_US-lessac-medium">English US (lessac, medium)</option>
        </select>
        <button
          type="button"
          onClick={handleReRender}
          className="rounded-xl bg-gradient-to-r from-purple-600 to-pink-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-purple-200 transition hover:opacity-90"
        >
          Re-render with new voice
        </button>
        {job.status !== "final" && (
          <button
            type="button"
            onClick={handleFinalize}
            disabled={finalizing}
            className="rounded-xl bg-gradient-to-r from-emerald-500 to-sky-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-emerald-100 transition hover:opacity-90 disabled:opacity-50"
          >
            {finalizing ? "Finalizing..." : "Finalize"}
          </button>
        )}
      </div>
    </div>
  );
}
