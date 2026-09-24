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
      const job = await submitRenderJob(params.id, "id_ID-voice-medium");
      router.push(`/campaigns/${params.id}/preview/${job.job_id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Assign Segments</h1>
      {Object.entries(drafts).map(([key, draft]) => (
        <SegmentEditor
          key={key}
          campaignId={params.id}
          segmentKey={key}
          assets={assets}
          draft={draft}
          onChange={(updated) => setDrafts({ ...drafts, [key]: updated })}
        />
      ))}
      <button type="button" onClick={handleSubmit}>
        Submit Render
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
