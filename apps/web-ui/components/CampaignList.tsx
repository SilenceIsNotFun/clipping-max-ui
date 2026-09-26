import Link from "next/link";
import { Campaign } from "../lib/apiClient";

const STATUS_STYLES: Record<string, string> = {
  uploaded: "bg-slate-100 text-slate-600",
  parsing: "bg-amber-100 text-amber-700",
  awaiting_details: "bg-sky-100 text-sky-700",
  planned: "bg-emerald-100 text-emerald-700",
  needs_review: "bg-rose-100 text-rose-700",
  failed: "bg-rose-100 text-rose-700",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${style}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function CampaignList({ campaigns }: { campaigns: Campaign[] }) {
  if (campaigns.length === 0) {
    return (
      <div className="rounded-3xl border-2 border-dashed border-purple-200 bg-white/60 p-10 text-center">
        <p className="text-lg font-medium text-slate-500">No campaigns yet — upload a BRD above to get started! 🚀</p>
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {campaigns.map((c) => (
        <Link
          key={c.id}
          href={`/campaigns/${c.id}`}
          className="group rounded-2xl border border-purple-100 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-purple-100"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold text-slate-800 group-hover:text-purple-600">{c.title}</h3>
            <StatusBadge status={c.status} />
          </div>
          <p className="mt-3 text-xs text-slate-400">Updated {new Date(c.updated_at).toLocaleString()}</p>
        </Link>
      ))}
    </div>
  );
}
