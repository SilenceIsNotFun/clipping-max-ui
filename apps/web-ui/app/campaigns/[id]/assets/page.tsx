"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VideoAsset, listAssets } from "../../../../lib/apiClient";
import { AssetUpload } from "../../../../components/AssetUpload";
import { AssetList } from "../../../../components/AssetList";

export default function AssetsPage({ params }: { params: { id: string } }) {
  const [assets, setAssets] = useState<VideoAsset[]>([]);

  async function refresh() {
    setAssets(await listAssets(params.id));
  }

  useEffect(() => {
    refresh();
  }, [params.id]);

  return (
    <main>
      <h1>Assets</h1>
      <AssetUpload campaignId={params.id} onUploaded={refresh} />
      <AssetList assets={assets} />
      <Link href={`/campaigns/${params.id}/segments`}>Next: assign segments</Link>
    </main>
  );
}
