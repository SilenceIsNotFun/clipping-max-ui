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
    <form
      onSubmit={handleSubmit}
      className="rounded-3xl bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 p-1 shadow-lg shadow-purple-200"
    >
      <div className="flex flex-col gap-3 rounded-[22px] bg-white p-6 sm:flex-row sm:items-center">
        <input
          type="text"
          name="title"
          placeholder="Content title"
          required
          className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none transition focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
        />
        <label className="flex-1 cursor-pointer rounded-xl border border-dashed border-slate-300 px-4 py-2.5 text-sm text-slate-500 transition hover:border-purple-300 hover:text-purple-600">
          <input type="file" name="file" required className="w-full text-sm file:hidden" />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="whitespace-nowrap rounded-xl bg-gradient-to-r from-purple-600 to-pink-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-purple-200 transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Uploading..." : "Upload BRD ✨"}
        </button>
      </div>
      {error && (
        <p role="alert" className="px-6 pb-4 text-sm font-medium text-rose-500">
          {error}
        </p>
      )}
    </form>
  );
}
