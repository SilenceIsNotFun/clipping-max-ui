"use client";

import { useEffect, useState } from "react";
import { CampaignDetail as CampaignDetailType, getCampaign } from "../../../lib/apiClient";
import { CampaignDetail } from "../../../components/CampaignDetail";

export default function CampaignDetailPage({ params }: { params: { id: string } }) {
  const [campaign, setCampaign] = useState<CampaignDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCampaign(params.id)
      .then(setCampaign)
      .catch((err) => setError((err as Error).message));
  }, [params.id]);

  if (error) return <p role="alert">{error}</p>;
  if (!campaign) return <p>Loading...</p>;
  return <CampaignDetail campaign={campaign} />;
}
