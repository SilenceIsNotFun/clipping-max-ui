"use client";

import { FormEvent, useState } from "react";
import { VideoAsset, uploadAsset } from "../lib/apiClient";

export function AssetUpload({
  campaignId,
  onUploaded,
}: {
  campaignId: string;
  onUploaded: (asset: VideoAsset) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
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

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-2xl border border-dashed border-orange-200 bg-orange-50/50 p-5 sm:flex-row sm:items-center"
    >
      <select
        name="asset_type"
        defaultValue="footage"
        className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
      >
        <option value="footage">🎬 Footage</option>
        <option value="music">🎵 Music</option>
        <option value="watermark">💧 Watermark</option>
      </select>
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
      {error && <p role="alert" className="text-sm font-medium text-rose-500">{error}</p>}
    </form>
  );
}
