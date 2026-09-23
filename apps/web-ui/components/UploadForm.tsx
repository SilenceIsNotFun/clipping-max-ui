"use client";

import { FormEvent, useState } from "react";
import { Campaign, uploadCampaign } from "../lib/apiClient";

export function UploadForm({ onUploaded }: { onUploaded: (c: Campaign) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData(e.currentTarget);
      const campaign = await uploadCampaign(formData);
      onUploaded(campaign);
      e.currentTarget.reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input type="file" name="file" required />
      <input type="text" name="title" placeholder="Campaign title" required />
      <input type="text" name="content_format" placeholder="Content format (e.g. 15s video)" required />
      <input type="text" name="target_language" placeholder="Target language" required />
      <input type="text" name="deadline" placeholder="Deadline" required />
      <input type="text" name="reward" placeholder="Reward" required />
      <input type="text" name="constraints" placeholder="Constraints" />
      <button type="submit" disabled={submitting}>
        {submitting ? "Uploading..." : "Upload BRD"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
