"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  SegmentDraft,
  VideoAsset,
  getCampaign,
  listAssets,
  saveSegments,
  submitRenderJob,
} from "../../../../lib/apiClient";
import { SegmentEditor } from "../../../../components/SegmentEditor";

export default function SegmentsPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [drafts, setDrafts] = useState<Record<string, SegmentDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [musicAssetId, setMusicAssetId] = useState<string>("");
  const musicAssets = assets.filter((a) => a.asset_type === "music");

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
      const job = await submitRenderJob(params.id, "id_ID-news_tts-medium", musicAssetId || undefined);
      router.push(`/campaigns/${params.id}/preview/${job.job_id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="flex flex-col gap-5">
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
