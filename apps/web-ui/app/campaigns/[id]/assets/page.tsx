"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VideoAsset, listAssets } from "../../../../lib/apiClient";
import { AssetUpload } from "../../../../components/AssetUpload";
import { AssetList } from "../../../../components/AssetList";
import { CampaignBreadcrumb } from "../../../../components/CampaignBreadcrumb";

export default function AssetsPage({ params }: { params: { id: string } }) {
  const [assets, setAssets] = useState<VideoAsset[]>([]);

  async function refresh() {
    setAssets(await listAssets(params.id));
  }

  useEffect(() => {
    refresh();
  }, [params.id]);

  return (
    <main className="flex flex-col gap-6">
      <CampaignBreadcrumb campaignId={params.id} current="Assets" />
      <h1 className="brand-gradient-text text-2xl font-bold sm:text-3xl">Footage & Music</h1>
      <AssetUpload campaignId={params.id} onUploaded={refresh} />
      <AssetList campaignId={params.id} assets={assets} onDeleted={refresh} />
      <Link
        href={`/campaigns/${params.id}/segments`}
        className="w-fit rounded-xl bg-gradient-to-r from-purple-600 to-pink-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-purple-200 transition hover:opacity-90"
      >
        Next: assign segments →
      </Link>
    </main>
  );
}
