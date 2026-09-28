"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CropRect,
  SegmentDraft,
  VideoAsset,
  getCampaign,
  listAssets,
  saveSegments,
  submitRenderJob,
} from "../../../../lib/apiClient";
import { SegmentEditor } from "../../../../components/SegmentEditor";
import { CropCanvas } from "../../../../components/CropCanvas";
import { CampaignBreadcrumb } from "../../../../components/CampaignBreadcrumb";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

function mediaUrl(filePath: string): string {
  return `${API_BASE_URL}/media${filePath.replace("/app/video-assets", "")}`;
}

export default function SegmentsPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [drafts, setDrafts] = useState<Record<string, SegmentDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [musicAssetId, setMusicAssetId] = useState<string>("");
  const musicAssets = assets.filter((a) => a.asset_type === "music");
  const [watermarkAssetId, setWatermarkAssetId] = useState<string>("");
  const [watermarkRect, setWatermarkRect] = useState<CropRect | null>(null);
  const watermarkAssets = assets.filter((a) => a.asset_type === "watermark");
  const previewFootageAsset = assets.find((a) => a.asset_type === "footage");

  useEffect(() => {
    Promise.all([listAssets(params.id), getCampaign(params.id)]).then(([assetList, campaign]) => {
      setAssets(assetList);
      const segmentKeys = Object.keys(campaign.plan?.content_plan ?? {});
      const initial: Record<string, SegmentDraft> = {};
      segmentKeys.forEach((key, index) => {
        initial[key] = {
          segment_key: key,
          video_asset_id: "",
          trim_start: 0,
          trim_end: 0,
          order_index: index,
          layout_template: "standard",
        };
      });
      setDrafts(initial);
    });
  }, [params.id]);

  async function handleSubmit() {
    setError(null);
    try {
      await saveSegments(params.id, Object.values(drafts));
      const job = await submitRenderJob(
        params.id,
        "id_ID-news_tts-medium",
        musicAssetId || undefined,
        watermarkAssetId || undefined,
        watermarkAssetId && watermarkRect ? watermarkRect : undefined
      );
      router.push(`/campaigns/${params.id}/preview/${job.job_id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="flex flex-col gap-5">
      <CampaignBreadcrumb campaignId={params.id} current="Segments" />
      <h1 className="brand-gradient-text text-2xl font-bold sm:text-3xl">Assign Segments</h1>
      {Object.entries(drafts).map(([key, draft]) => (
        <SegmentEditor
          key={key}
          campaignId={params.id}
          segmentKey={key}
          assets={assets}
          draft={draft}
          onChange={(updated) =>
            setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...updated } }))
          }
        />
      ))}
      <div className="rounded-2xl border border-orange-100 bg-orange-50/50 p-5">
        <label className="flex flex-col gap-2 text-sm font-medium text-slate-600 sm:flex-row sm:items-center sm:gap-3">
          Background music
          <select
            value={musicAssetId}
            onChange={(e) => setMusicAssetId(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          >
            <option value="">No music</option>
            {musicAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.file_path.split("/").pop()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="rounded-2xl border border-sky-100 bg-sky-50/50 p-5">
        <label className="flex flex-col gap-2 text-sm font-medium text-slate-600 sm:flex-row sm:items-center sm:gap-3">
          Watermark
          <select
            value={watermarkAssetId}
            onChange={(e) => {
              setWatermarkAssetId(e.target.value);
              setWatermarkRect(null);
            }}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
          >
            <option value="">No watermark</option>
            {watermarkAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.file_path.split("/").pop()}
              </option>
            ))}
          </select>
        </label>
        {watermarkAssetId && previewFootageAsset && (
          <div className="mt-3 rounded-xl bg-white p-3">
            <p className="mb-2 text-xs text-slate-400">
              Drag a box for where the watermark should appear (preview uses any selected footage as a visual reference).
            </p>
            <CropCanvas
              imageSrc={mediaUrl(previewFootageAsset.file_path)}
              label="Watermark placement"
              onChange={setWatermarkRect}
            />
          </div>
        )}
        {watermarkAssetId && !previewFootageAsset && (
          <p className="mt-2 text-xs text-rose-500">Assign a footage asset to a segment first to preview placement.</p>
        )}
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        className="w-fit rounded-xl bg-gradient-to-r from-purple-600 via-pink-500 to-orange-400 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-200 transition hover:opacity-90"
      >
        Submit Render 🎬
      </button>
      {error && (
        <p role="alert" className="text-sm font-medium text-rose-500">
          {error}
        </p>
      )}
    </main>
  );
}
