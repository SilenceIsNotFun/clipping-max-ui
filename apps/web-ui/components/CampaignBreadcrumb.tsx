"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getCampaign } from "../lib/apiClient";

export function CampaignBreadcrumb({
  campaignId,
  current,
}: {
  campaignId: string;
  current?: string;
}) {
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCampaign(campaignId)
      .then((campaign) => {
        if (!cancelled) setTitle(campaign.title);
      })
      .catch(() => {
        if (!cancelled) setTitle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  return (
    <nav className="flex flex-wrap items-center gap-1.5 text-sm text-slate-400">
      <Link href="/" className="hover:text-slate-600 hover:underline">
        Campaigns
      </Link>
      <span>/</span>
      {current ? (
        <Link href={`/campaigns/${campaignId}`} className="hover:text-slate-600 hover:underline">
          {title ?? "..."}
        </Link>
      ) : (
        <span className="font-medium text-slate-600">{title ?? "..."}</span>
      )}
      {current && (
        <>
          <span>/</span>
          <span className="font-medium text-slate-600">{current}</span>
        </>
      )}
    </nav>
  );
}
