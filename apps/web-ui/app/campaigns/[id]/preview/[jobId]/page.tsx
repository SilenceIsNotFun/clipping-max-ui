"use client";

import { useEffect, useState } from "react";
import { RenderJobDetail, getRenderJob } from "../../../../../lib/apiClient";
import { RenderPreview } from "../../../../../components/RenderPreview";
import { CampaignBreadcrumb } from "../../../../../components/CampaignBreadcrumb";

export default function PreviewPage({ params }: { params: { id: string; jobId: string } }) {
  const [job, setJob] = useState<RenderJobDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const result = await getRenderJob(params.id, params.jobId);
      if (cancelled) return;
      setJob(result);
      if (result.status === "rendering" || result.status === "queued") {
        setTimeout(poll, 3000);
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [params.id, params.jobId]);

  if (!job)
    return (
      <div className="flex flex-col gap-4">
        <CampaignBreadcrumb campaignId={params.id} current="Preview" />
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  return (
    <main className="flex flex-col gap-5">
      <CampaignBreadcrumb campaignId={params.id} current="Preview" />
      <h1 className="brand-gradient-text text-2xl font-bold sm:text-3xl">Render Preview</h1>
      <RenderPreview campaignId={params.id} job={job} />
    </main>
  );
}
