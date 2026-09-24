"use client";

import { useEffect, useState } from "react";
import { RenderJobDetail, getRenderJob } from "../../../../../lib/apiClient";
import { RenderPreview } from "../../../../../components/RenderPreview";

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

  if (!job) return <p>Loading...</p>;
  return (
    <main>
      <h1>Render Preview</h1>
      <RenderPreview campaignId={params.id} job={job} />
    </main>
  );
}
