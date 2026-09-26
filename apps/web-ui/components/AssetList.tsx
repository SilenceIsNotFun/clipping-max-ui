"use client";

import { useState } from "react";
import { VideoAsset, deleteAsset } from "../lib/apiClient";

const ANALYSIS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  done: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
};

export function AssetList({
  campaignId,
  assets,
  onDeleted,
}: {
  campaignId: string;
  assets: VideoAsset[];
  onDeleted: () => void;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(assetId: string) {
    if (!confirm("Delete this asset? This can't be undone.")) return;
    setDeletingId(assetId);
    setError(null);
    try {
      await deleteAsset(campaignId, assetId);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  if (assets.length === 0) {
    return <p className="text-sm text-slate-400">No assets uploaded yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm font-medium text-rose-500">
          {error}
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {assets.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-700">{a.file_path.split("/").pop()}</p>
              <p className="text-xs text-slate-400">
                {a.asset_type === "footage" ? "🎬" : "🎵"} {a.asset_type} · {a.duration_seconds.toFixed(1)}s
              </p>
            </div>
            <div className="flex items-center gap-2">
              {a.asset_type === "footage" && (
                <span className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${ANALYSIS_STYLES[a.analysis_status] ?? "bg-slate-100 text-slate-600"}`}>
                  {a.analysis_status}
                </span>
              )}
              <button
                type="button"
                onClick={() => handleDelete(a.id)}
                disabled={deletingId === a.id}
                title="Delete asset"
                className="rounded-full p-1.5 text-rose-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              >
                {deletingId === a.id ? "…" : "🗑️"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
