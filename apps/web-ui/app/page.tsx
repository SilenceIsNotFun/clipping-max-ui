"use client";

import { useEffect, useState } from "react";
import { Campaign, listCampaigns } from "../lib/apiClient";
import { UploadForm } from "../components/UploadForm";
import { CampaignList } from "../components/CampaignList";

export default function HomePage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  async function refresh() {
    setCampaigns(await listCampaigns());
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <main>
      <h1>ContentRewardFarm</h1>
      <UploadForm onUploaded={refresh} />
      <CampaignList campaigns={campaigns} />
    </main>
  );
}
