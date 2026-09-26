"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { CampaignDetail as CampaignDetailType, planCampaign, retryCampaign } from "../lib/apiClient";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

const inputClass =
  "rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none transition focus:border-purple-400 focus:ring-2 focus:ring-purple-100";

export function CampaignDetail({
  campaign,
  onPlanned,
}: {
  campaign: CampaignDetailType;
  onPlanned: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePlanSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData(e.currentTarget);
      const details = {
        content_format: String(formData.get("content_format") ?? ""),
        target_language: String(formData.get("target_language") ?? ""),
        deadline: String(formData.get("deadline") ?? ""),
        reward: String(formData.get("reward") ?? ""),
        constraints: String(formData.get("constraints") ?? ""),
      };
      if (campaign.status === "needs_review") {
        await retryCampaign(campaign.id, details);
      } else {
        await planCampaign(campaign.id, details);
      }
      onPlanned();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-800 sm:text-3xl">{campaign.title}</h1>
        <span className="rounded-full bg-purple-100 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-purple-700">
          {campaign.status.replace(/_/g, " ")}
        </span>
      </div>

      <Link
        href={`/campaigns/${campaign.id}/assets`}
        className="w-fit rounded-xl bg-gradient-to-r from-purple-600 to-pink-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-purple-200 transition hover:opacity-90"
      >
        Manage footage & clips →
      </Link>

      {campaign.status === "needs_review" && (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <p className="font-semibold">This campaign needs manual review.</p>
          {campaign.review_tasks.length > 0 && <p className="mt-1">{campaign.review_tasks[0].reason}</p>}
        </div>
      )}

      {(campaign.status === "awaiting_details" || campaign.status === "needs_review") && (
        <section className="rounded-2xl border border-sky-100 bg-sky-50/60 p-6">
          <h2 className="text-lg font-semibold text-slate-800">
            {campaign.status === "needs_review" ? "Try Again" : "Content Details"}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {campaign.status === "needs_review"
              ? "Fix any details below and retry parsing + plan generation."
              : "BRD parsed. Fill in these details, then generate the content plan."}
          </p>
          <form onSubmit={handlePlanSubmit} className="mt-4 grid gap-3 sm:grid-cols-2">
            <input type="text" name="content_format" placeholder="Content format (e.g. 15s video)" required className={inputClass} />
            <input type="text" name="target_language" placeholder="Target language" required className={inputClass} />
            <input type="text" name="deadline" placeholder="Deadline" required className={inputClass} />
            <input type="text" name="reward" placeholder="Reward" required className={inputClass} />
            <input type="text" name="constraints" placeholder="Constraints" className={`${inputClass} sm:col-span-2`} />
            <button
              type="submit"
              disabled={submitting}
              className="w-fit rounded-xl bg-gradient-to-r from-sky-500 to-purple-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-sky-100 transition hover:opacity-90 disabled:opacity-50 sm:col-span-2"
            >
              {submitting
                ? campaign.status === "needs_review"
                  ? "Retrying..."
                  : "Generating..."
                : campaign.status === "needs_review"
                  ? "Try Again 🔁"
                  : "Generate Plan ✨"}
            </button>
            {error && (
              <p role="alert" className="text-sm font-medium text-rose-500 sm:col-span-2">
                {error}
              </p>
            )}
          </form>
        </section>
      )}

      {campaign.document && (
        <section className="rounded-2xl border border-purple-100 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-800">Parsed Document</h2>
          <p className="mt-1 text-sm text-slate-400">
            Confidence: {Math.round(campaign.document.parsing_confidence * 100)}%
          </p>
          {campaign.document.extracted_links.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {campaign.document.extracted_links.map((link) => (
                <li key={link}>
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full bg-purple-50 px-3 py-1 text-xs text-purple-600 hover:bg-purple-100"
                  >
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs text-slate-600">
            {campaign.document.raw_text}
          </pre>
        </section>
      )}

      {campaign.plan && (
        <section className="rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-800">Plan</h2>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
              Opportunity score: {campaign.plan.opportunity_score}
            </span>
          </div>
          <p className="mt-3 text-sm text-slate-600">{campaign.plan.strategy_summary}</p>
          <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-slate-600">
            {campaign.plan.requirements_checklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs text-slate-600">
            {JSON.stringify(campaign.plan.content_plan, null, 2)}
          </pre>
          <a
            href={`${API_BASE_URL}/api/campaigns/${campaign.id}/pdf`}
            className="mt-4 inline-block rounded-xl bg-gradient-to-r from-emerald-500 to-sky-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-emerald-100 transition hover:opacity-90"
          >
            Download PDF
          </a>
        </section>
      )}
    </div>
  );
}
