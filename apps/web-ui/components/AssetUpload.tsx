"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { VideoAsset, getAssetCategories, getYoutubeDownloadJob, triggerYoutubeDownload, uploadAsset } from "../lib/apiClient";

export function AssetUpload({
  campaignId,
  onUploaded,
}: {
  campaignId: string;
  onUploaded: (asset: VideoAsset) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(["footage", "clip", "broll", "music", "watermark"]);
  const [mode, setMode] = useState<"file" | "youtube">("file");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded_bytes: number | null;
    total_bytes: number | null;
    speed_bytes_per_sec: number | null;
  } | null>(null);
  const youtubePollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getAssetCategories(campaignId).then(setCategories).catch(() => {});
  }, [campaignId]);

  useEffect(() => {
    return () => {
      if (youtubePollIntervalRef.current !== null) clearInterval(youtubePollIntervalRef.current);
    };
  }, []);

  async function handleFileSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Capture the form element now -- e.currentTarget can become null once
    // this handler resumes after the `await` below.
    const form = e.currentTarget;
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData(form);
      const asset = await uploadAsset(campaignId, formData);
      onUploaded(asset);
      form.reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleYoutubeSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setDownloading(true);
    setDownloadProgress(null);
    let jobId: string;
    try {
      const result = await triggerYoutubeDownload(campaignId, youtubeUrl);
      jobId = result.job_id;
    } catch (err) {
      setError((err as Error).message);
      setDownloading(false);
      return;
    }

    if (youtubePollIntervalRef.current !== null) clearInterval(youtubePollIntervalRef.current);
    youtubePollIntervalRef.current = setInterval(async () => {
      try {
        const job = await getYoutubeDownloadJob(campaignId, jobId);
        if (job.status === "downloading") {
          setDownloadProgress({
            downloaded_bytes: job.downloaded_bytes,
            total_bytes: job.total_bytes,
            speed_bytes_per_sec: job.speed_bytes_per_sec,
          });
        } else if (job.status === "done") {
          if (youtubePollIntervalRef.current !== null) clearInterval(youtubePollIntervalRef.current);
          setDownloading(false);
          setDownloadProgress(null);
          setYoutubeUrl("");
          // The parent page's onUploaded handler (see
          // apps/web-ui/app/campaigns/[id]/assets/page.tsx) is wired to a
          // no-arg `refresh` that re-fetches the full asset list from the
          // server -- it never reads fields off the object passed here. So
          // this placeholder is safe: its blank file_path/duration_seconds
          // are discarded, not rendered.
          onUploaded({
            id: job.result_asset_id as string,
            campaign_id: campaignId,
            file_path: "",
            asset_type: "footage",
            duration_seconds: 0,
            analysis_status: "pending",
            hook_status: "none",
            created_at: job.created_at,
          });
        } else if (job.status === "failed") {
          if (youtubePollIntervalRef.current !== null) clearInterval(youtubePollIntervalRef.current);
          setDownloading(false);
          setError(job.error_message ?? "youtube download failed");
        }
      } catch {
        // transient poll failure -- keep trying
      }
    }, 2000);
  }

  function formatBytes(bytes: number | null): string {
    if (bytes === null) return "?";
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-orange-200 bg-orange-50/50 p-5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("file")}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === "file" ? "bg-orange-500 text-white" : "bg-white text-slate-500"}`}
        >
          Upload File
        </button>
        <button
          type="button"
          onClick={() => setMode("youtube")}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === "youtube" ? "bg-orange-500 text-white" : "bg-white text-slate-500"}`}
        >
          Paste YouTube Link
        </button>
      </div>

      {mode === "file" && (
        <form onSubmit={handleFileSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            list="asset-categories"
            name="asset_type"
            defaultValue="footage"
            placeholder="Category (e.g. footage, broll, music)"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
          <datalist id="asset-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <input
            type="file"
            name="file"
            required
            className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
          <button
            type="submit"
            disabled={submitting}
            className="whitespace-nowrap rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-orange-100 transition hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Uploading..." : "Upload"}
          </button>
        </form>
      )}

      {mode === "youtube" && (
        <form onSubmit={handleYoutubeSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="url"
            required
            placeholder="https://youtube.com/watch?v=..."
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            disabled={downloading}
            className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
          <button
            type="submit"
            disabled={downloading}
            className="whitespace-nowrap rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-orange-100 transition hover:opacity-90 disabled:opacity-50"
          >
            {downloading ? "Downloading..." : "Download"}
          </button>
        </form>
      )}

      {downloading && (
        <div className="rounded-xl bg-white p-3 text-xs text-slate-500">
          {downloadProgress ? (
            <p>
              {formatBytes(downloadProgress.downloaded_bytes)} / {formatBytes(downloadProgress.total_bytes)}
              {downloadProgress.speed_bytes_per_sec !== null &&
                ` — ${(downloadProgress.speed_bytes_per_sec / 1024 / 1024).toFixed(1)}MB/s`}
            </p>
          ) : (
            <p>Starting download...</p>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-sm font-medium text-rose-500">{error}</p>}
    </div>
  );
}
