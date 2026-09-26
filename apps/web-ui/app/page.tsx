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
    <main className="flex flex-col gap-8">
      <div>
        <h1 className="brand-gradient-text text-3xl font-bold sm:text-4xl">ContentRewardFarm</h1>
        <p className="mt-1 text-slate-500">Turn a brand reward brief into a content plan in minutes.</p>
      </div>
      <UploadForm onUploaded={refresh} />
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Your campaigns</h2>
        <CampaignList campaigns={campaigns} />
      </div>
    </main>
  );
}
