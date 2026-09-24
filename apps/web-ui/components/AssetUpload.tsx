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
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData(e.currentTarget);
      const asset = await uploadAsset(campaignId, formData);
      onUploaded(asset);
      e.currentTarget.reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <select name="asset_type" defaultValue="footage">
        <option value="footage">Footage</option>
        <option value="music">Music</option>
      </select>
      <input type="file" name="file" required />
      <button type="submit" disabled={submitting}>
        {submitting ? "Uploading..." : "Upload"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
