"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CropRect,
  CropSuggestion,
  CutJob,
  HookSuggestion,
  LayoutTemplate,
  MomentCandidate,
  SegmentDraft,
  VideoAsset,
  findHooks,
  getCropSuggestion,
  getCutJob,
  getHookSuggestions,
  listAssets,
  listMoments,
  triggerCut,
} from "../lib/apiClient";
import { TimelineScrubber } from "./TimelineScrubber";
import { CropCanvas } from "./CropCanvas";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

function mediaUrl(filePath: string): string {
  return `${API_BASE_URL}/media${filePath.replace("/app/video-assets", "")}`;
}

const TEMPLATES: LayoutTemplate[] = [
  "standard",
  "gameplay_facecam_split",
  "gameplay_full_focus",
  "cinematic_letterbox",
];

const CAPTION_STYLES = ["default", "energetic", "warning"];

export function SegmentEditor({
  campaignId,
  assets,
  draft,
  onChange,
  onAssetCreated,
}: {
  campaignId: string;
  assets: VideoAsset[];
  draft: SegmentDraft;
  onChange: (draft: SegmentDraft) => void;
  onAssetCreated: () => Promise<void>;
}) {
  const [moments, setMoments] = useState<MomentCandidate[]>([]);
  const [cropSuggestion, setCropSuggestion] = useState<CropSuggestion | null>(null);
  const [hookSuggestions, setHookSuggestions] = useState<HookSuggestion[]>([]);
  const [findingHooks, setFindingHooks] = useState(false);
  const [hookError, setHookError] = useState<string | null>(null);
  const asset = assets.find((a) => a.id === draft.video_asset_id);

  // Kept in sync with the latest draft on every render so the cut-poll
  // callback (which closes over values from the render in which handleCut
  // was invoked) never reverts concurrent edits made while the cut runs.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const [cutStartSeconds, setCutStartSeconds] = useState(0);
  const [cutDurationSeconds, setCutDurationSeconds] = useState(0);
  const [cutting, setCutting] = useState(false);
  const [cutError, setCutError] = useState<string | null>(null);
  const [appliedHookReasoning, setAppliedHookReasoning] = useState<string | null>(null);
  const cutPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopCutPolling() {
    if (cutPollIntervalRef.current !== null) {
      clearInterval(cutPollIntervalRef.current);
      cutPollIntervalRef.current = null;
    }
  }

  useEffect(() => {
    return () => stopCutPolling();
  }, [campaignId, draft.video_asset_id]);

  const isBroll = draft.segment_key.trim().toLowerCase() === "broll";
  const sourceCandidates = assets.filter((a) =>
    isBroll ? a.asset_type === "broll" : a.asset_type === "footage" || a.asset_type === "clip"
  );
  const [cutSourceAssetId, setCutSourceAssetId] = useState("");
  const cutSourceAsset = assets.find((a) => a.id === cutSourceAssetId);

  // Shared by the manual "Potong & Gunakan" button and applyHookSuggestion
  // below -- both trigger a cut, poll for completion, and land the result on
  // the segment the same way; extraFields lets the caller merge in anything
  // beyond video_asset_id/trim_start/trim_end (e.g. title_text from a hook).
  async function startCutAndApply(
    sourceAssetId: string,
    startSeconds: number,
    durationSeconds: number,
    extraFields: Partial<SegmentDraft> = {}
  ) {
    if (durationSeconds <= 0) return;
    setCutting(true);
    setCutError(null);
    let jobId: string;
    try {
      const result = await triggerCut(campaignId, sourceAssetId, startSeconds, durationSeconds);
      jobId = result.cut_job_id;
    } catch (err) {
      setCutError((err as Error).message);
      setCutting(false);
      return;
    }

    stopCutPolling();
    cutPollIntervalRef.current = setInterval(async () => {
      try {
        const job: CutJob = await getCutJob(campaignId, jobId);
        if (job.status === "done" && job.result_asset_id) {
          stopCutPolling();
          setCutting(false);

          // The new clip asset was just created server-side and isn't in
          // the parent's `assets` state yet -- refresh it first so the
          // asset lookups below (and the re-render this component gets
          // once onChange fires) can find it.
          await onAssetCreated();

          // Prefer the actual trimmed duration over durationSeconds
          // (the *requested* duration, which can differ from what ffmpeg
          // actually produced) for trim_end.
          let trimEnd = durationSeconds;
          try {
            const latestAssets = await listAssets(campaignId);
            const newAsset = latestAssets.find((a) => a.id === job.result_asset_id);
            if (newAsset) trimEnd = newAsset.duration_seconds;
          } catch {
            // fall back to the requested duration if the lookup fails
          }

          onChange({
            ...draftRef.current,
            ...extraFields,
            video_asset_id: job.result_asset_id,
            trim_start: 0,
            trim_end: trimEnd,
          });
        } else if (job.status === "failed") {
          stopCutPolling();
          setCutting(false);
          setCutError(job.error_message ?? "cut failed");
        }
      } catch {
        // transient poll failure -- keep trying
      }
    }, 3000);
  }

  async function handleCut() {
    if (!cutSourceAsset) return;
    await startCutAndApply(cutSourceAsset.id, cutStartSeconds, cutDurationSeconds);
  }

  const hookPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hookPollAttemptsRef = useRef(0);

  const HOOK_POLL_INTERVAL_MS = 5000;
  const HOOK_POLL_MAX_ATTEMPTS = 60; // ~5 minutes, matching Gemini's realistic turnaround

  function stopHookPolling() {
    if (hookPollIntervalRef.current !== null) {
      clearInterval(hookPollIntervalRef.current);
      hookPollIntervalRef.current = null;
    }
  }

  // Stop polling (and never apply results to the wrong segment) whenever the
  // selected asset changes, and on unmount.
  useEffect(() => {
    return () => stopHookPolling();
  }, [campaignId, draft.video_asset_id]);

  useEffect(() => {
    if (draft.video_asset_id) {
      getHookSuggestions(campaignId, draft.video_asset_id).then(setHookSuggestions);
    } else {
      setHookSuggestions([]);
    }
  }, [campaignId, draft.video_asset_id]);

  async function handleFindHooks() {
    if (!draft.video_asset_id) return;
    const assetId = draft.video_asset_id;
    const countBeforeRun = hookSuggestions.length;
    setFindingHooks(true);
    setHookError(null);
    try {
      await findHooks(campaignId, assetId);
    } catch (err) {
      setHookError((err as Error).message);
      setFindingHooks(false);
      return;
    }

    // The 202 above only confirms the run was triggered -- Gemini's actual
    // result arrives seconds to minutes later via the hooks-complete
    // callback. Poll for it instead of flipping findingHooks back off
    // immediately, which previously left the operator staring at a button
    // that reset with no suggestions ever appearing short of a full page
    // reload (which would also destroy any unsaved segment edits).
    stopHookPolling();
    hookPollAttemptsRef.current = 0;
    hookPollIntervalRef.current = setInterval(async () => {
      hookPollAttemptsRef.current += 1;
      try {
        const latest = await getHookSuggestions(campaignId, assetId);
        if (latest.length > countBeforeRun) {
          setHookSuggestions(latest);
          stopHookPolling();
          setFindingHooks(false);
          return;
        }
      } catch {
        // transient poll failure -- keep trying until the attempt cap
      }

      if (hookPollAttemptsRef.current >= HOOK_POLL_MAX_ATTEMPTS) {
        stopHookPolling();
        setFindingHooks(false);
        setHookError("Still processing — check back in a bit");
      }
    }, HOOK_POLL_INTERVAL_MS);
  }

  // Applying a suggestion cuts the suggested window into its own clip asset
  // (the same mechanism as the manual "Potong & Gunakan" button) rather than
  // just narrowing the trim window on the full source -- so the operator
  // ends up with a real, ready-to-use clip immediately, no separate manual
  // cut step needed.
  async function applyHookSuggestion(suggestion: HookSuggestion) {
    if (!draft.video_asset_id) return;
    setAppliedHookReasoning(suggestion.reasoning);
    await startCutAndApply(
      draft.video_asset_id,
      suggestion.start_ms / 1000,
      (suggestion.end_ms - suggestion.start_ms) / 1000,
      { title_text: suggestion.title }
    );
  }

  useEffect(() => {
    if (draft.video_asset_id) {
      listMoments(campaignId, draft.video_asset_id).then(setMoments);
    }
  }, [campaignId, draft.video_asset_id]);

  useEffect(() => {
    if (draft.video_asset_id) {
      getCropSuggestion(campaignId, draft.video_asset_id).then(setCropSuggestion);
    } else {
      setCropSuggestion(null);
    }
  }, [campaignId, draft.video_asset_id]);

  const gameplaySuggestedRect = useMemo(
    () => (cropSuggestion?.crop_gameplay_rect ? JSON.parse(cropSuggestion.crop_gameplay_rect) : null),
    [cropSuggestion?.crop_gameplay_rect]
  );
  const facecamSuggestedRect = useMemo(
    () => (cropSuggestion?.crop_facecam_rect ? JSON.parse(cropSuggestion.crop_facecam_rect) : null),
    [cropSuggestion?.crop_facecam_rect]
  );

  const needsGameplayCrop =
    !draft.secondary_video_asset_id &&
    (draft.layout_template === "gameplay_full_focus" || draft.layout_template === "gameplay_facecam_split");
  const needsFacecamCrop = !draft.secondary_video_asset_id && draft.layout_template === "gameplay_facecam_split";

  const selectClass =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100";

  return (
    <fieldset className="flex flex-col gap-4 rounded-2xl border border-purple-100 bg-white p-5 shadow-sm">
      <legend className="rounded-full bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-1 text-sm font-semibold text-white">
        Segment
      </legend>

      <input
        list={`segment-labels-${campaignId}`}
        type="text"
        placeholder="Label (e.g. hook, body, broll)"
        value={draft.segment_key}
        onChange={(e) => onChange({ ...draft, segment_key: e.target.value })}
        className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
      />
      <datalist id={`segment-labels-${campaignId}`}>
        <option value="hook" />
        <option value="body" />
        <option value="broll" />
      </datalist>

      <div className="grid gap-3 sm:grid-cols-2">
        <select
          value={draft.layout_template}
          onChange={(e) => onChange({ ...draft, layout_template: e.target.value as LayoutTemplate })}
          className={selectClass}
        >
          {TEMPLATES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-xl border border-purple-100 bg-purple-50/40 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-600">
          Cut a piece from a source asset
        </p>
        <select
          value={cutSourceAssetId}
          onChange={(e) => setCutSourceAssetId(e.target.value)}
          className={selectClass}
        >
          <option value="">Select source</option>
          {sourceCandidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.file_path.split("/").pop()}
            </option>
          ))}
        </select>
        {sourceCandidates.length === 0 && (
          <p className="mt-2 text-xs text-rose-500">
            No {isBroll ? "broll" : "footage/clip"} assets yet — upload one first.
          </p>
        )}
        {cutSourceAsset && (
          <button
            type="button"
            onClick={() =>
              onChange({ ...draft, video_asset_id: cutSourceAsset.id, trim_start: 0, trim_end: cutSourceAsset.duration_seconds })
            }
            className="mt-2 text-xs font-medium text-purple-600 underline"
          >
            Atau pakai asset ini apa adanya (tanpa potong)
          </button>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input
            type="number"
            min={0}
            step={0.1}
            placeholder="Start (detik)"
            value={cutStartSeconds}
            onChange={(e) => setCutStartSeconds(Number(e.target.value))}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
          />
          <input
            type="number"
            min={0}
            step={0.1}
            placeholder="Durasi (detik)"
            value={cutDurationSeconds}
            onChange={(e) => setCutDurationSeconds(Number(e.target.value))}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
          />
        </div>
        <button
          type="button"
          onClick={handleCut}
          disabled={cutting || !cutSourceAssetId || cutDurationSeconds <= 0}
          className="mt-2 w-fit rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-purple-100 transition hover:opacity-90 disabled:opacity-50"
        >
          {cutting ? "Memotong..." : "Potong & Gunakan"}
        </button>
        {cutError && (
          <p role="alert" className="mt-2 text-sm font-medium text-rose-500">
            {cutError}
          </p>
        )}
        {draft.video_asset_id && (
          <p className="mt-2 text-xs text-emerald-600">
            Segmen ini pakai: {assets.find((a) => a.id === draft.video_asset_id)?.file_path.split("/").pop()}
          </p>
        )}
      </div>

      {asset && (
        <div className="rounded-xl bg-slate-50 p-3">
          <TimelineScrubber
            src={mediaUrl(asset.file_path)}
            durationSeconds={asset.duration_seconds}
            moments={moments}
            trimStart={draft.trim_start}
            trimEnd={draft.trim_end}
            onChange={(start, end) => onChange({ ...draft, trim_start: start, trim_end: end })}
          />
        </div>
      )}

      {asset && asset.analysis_status === "done" && asset.asset_type === "footage" && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleFindHooks}
            disabled={findingHooks}
            className="w-fit rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-orange-100 transition hover:opacity-90 disabled:opacity-50"
          >
            {findingHooks ? "Asking Gemini..." : "Find Hooks 🎯"}
          </button>
          {hookError && (
            <p role="alert" className="text-sm font-medium text-rose-500">
              {hookError}
            </p>
          )}
          {hookSuggestions.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-orange-100 bg-orange-50/50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">Suggested Hooks</p>
              {cutting && <p className="text-xs font-medium text-purple-600">✂️ Memotong klip...</p>}
              {cutError && (
                <p role="alert" className="text-xs font-medium text-rose-500">
                  {cutError}
                </p>
              )}
              {hookSuggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => applyHookSuggestion(s)}
                  disabled={cutting}
                  className="rounded-lg border border-orange-200 bg-white p-3 text-left transition hover:border-orange-400 hover:bg-orange-50 disabled:opacity-50"
                >
                  <p className="text-sm font-semibold text-slate-800">{s.title}</p>
                  <p className="text-xs text-slate-500">
                    {(s.start_ms / 1000).toFixed(1)}s &ndash; {(s.end_ms / 1000).toFixed(1)}s
                  </p>
                  <p className="mt-1 text-xs text-slate-400">{s.reasoning}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {needsGameplayCrop && asset && (
        <div className="rounded-xl bg-slate-50 p-3">
          <CropCanvas
            imageSrc={mediaUrl(asset.file_path)}
            label="Gameplay area"
            initialRect={gameplaySuggestedRect}
            onChange={(rect: CropRect) => onChange({ ...draft, crop_gameplay_rect: rect })}
          />
        </div>
      )}
      {needsFacecamCrop && asset && (
        <div className="rounded-xl bg-slate-50 p-3">
          <CropCanvas
            imageSrc={mediaUrl(asset.file_path)}
            label="Facecam area"
            initialRect={facecamSuggestedRect}
            onChange={(rect: CropRect) => onChange({ ...draft, crop_facecam_rect: rect })}
          />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <input
            type="text"
            placeholder="Title text (optional)"
            value={draft.title_text ?? ""}
            onChange={(e) => onChange({ ...draft, title_text: e.target.value })}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
          />
          {appliedHookReasoning && (
            <p className="px-1 text-xs text-slate-500">💡 Kenapa dipilih: {appliedHookReasoning}</p>
          )}
        </div>

        <select
          value={draft.caption_style ?? "default"}
          onChange={(e) => onChange({ ...draft, caption_style: e.target.value })}
          className={selectClass}
        >
          {CAPTION_STYLES.map((style) => (
            <option key={style} value={style}>
              {style}
            </option>
          ))}
        </select>
      </div>

      {draft.title_text && asset && (
        <div className="rounded-xl bg-slate-50 p-3">
          <CropCanvas
            imageSrc={mediaUrl(asset.file_path)}
            label="Title placement"
            initialRect={draft.title_rect ?? null}
            onChange={(rect: CropRect) => onChange({ ...draft, title_rect: rect })}
          />
        </div>
      )}
    </fieldset>
  );
}
