"use client";

import { useEffect, useState } from "react";
import { CampaignDetail as CampaignDetailType, getCampaign } from "../../../lib/apiClient";
import { CampaignDetail } from "../../../components/CampaignDetail";
import { CampaignBreadcrumb } from "../../../components/CampaignBreadcrumb";

export default function CampaignDetailPage({ params }: { params: { id: string } }) {
  const [campaign, setCampaign] = useState<CampaignDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    getCampaign(params.id)
      .then(setCampaign)
      .catch((err) => setError((err as Error).message));
  }

  useEffect(() => {
    refresh();
  }, [params.id]);

  if (error)
    return (
      <p role="alert" className="text-sm font-medium text-rose-500">
        {error}
      </p>
    );
  if (!campaign)
    return (
      <div className="flex flex-col gap-4">
        <CampaignBreadcrumb campaignId={params.id} />
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <CampaignBreadcrumb campaignId={params.id} />
      <CampaignDetail campaign={campaign} onPlanned={refresh} />
    </div>
  );
}
