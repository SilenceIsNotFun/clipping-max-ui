import { VideoAsset } from "../lib/apiClient";

export function AssetList({ assets }: { assets: VideoAsset[] }) {
  if (assets.length === 0) return <p>No assets uploaded yet.</p>;
  return (
    <ul>
      {assets.map((a) => (
        <li key={a.id}>
          {a.file_path.split("/").pop()} — {a.asset_type} — {a.duration_seconds.toFixed(1)}s
          {a.asset_type === "footage" && <span> — analysis: {a.analysis_status}</span>}
        </li>
      ))}
    </ul>
  );
}
