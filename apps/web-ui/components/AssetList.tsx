import { VideoAsset } from "../lib/apiClient";

const ANALYSIS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  done: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
};

export function AssetList({ assets }: { assets: VideoAsset[] }) {
  if (assets.length === 0) {
    return <p className="text-sm text-slate-400">No assets uploaded yet.</p>;
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {assets.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-700">{a.file_path.split("/").pop()}</p>
            <p className="text-xs text-slate-400">
              {a.asset_type === "footage" ? "🎬" : "🎵"} {a.asset_type} · {a.duration_seconds.toFixed(1)}s
            </p>
          </div>
          {a.asset_type === "footage" && (
            <span className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${ANALYSIS_STYLES[a.analysis_status] ?? "bg-slate-100 text-slate-600"}`}>
              {a.analysis_status}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
