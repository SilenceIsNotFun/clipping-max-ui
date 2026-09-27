"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CropRect,
  CropSuggestion,
  HookSuggestion,
  LayoutTemplate,
  MomentCandidate,
  SegmentDraft,
  VideoAsset,
  findHooks,
  getCropSuggestion,
  getHookSuggestions,
  listMoments,
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
  segmentKey,
  assets,
  draft,
  onChange,
}: {
  campaignId: string;
  segmentKey: string;
  assets: VideoAsset[];
  draft: SegmentDraft;
  onChange: (draft: SegmentDraft) => void;
}) {
  const [moments, setMoments] = useState<MomentCandidate[]>([]);
  const [cropSuggestion, setCropSuggestion] = useState<CropSuggestion | null>(null);
  const [hookSuggestions, setHookSuggestions] = useState<HookSuggestion[]>([]);
  const [findingHooks, setFindingHooks] = useState(false);
  const [hookError, setHookError] = useState<string | null>(null);
  const asset = assets.find((a) => a.id === draft.video_asset_id);

  useEffect(() => {
    if (draft.video_asset_id) {
      getHookSuggestions(campaignId, draft.video_asset_id).then(setHookSuggestions);
    } else {
      setHookSuggestions([]);
    }
  }, [campaignId, draft.video_asset_id]);

  async function handleFindHooks() {
    if (!draft.video_asset_id) return;
    setFindingHooks(true);
    setHookError(null);
    try {
      await findHooks(campaignId, draft.video_asset_id);
    } catch (err) {
      setHookError((err as Error).message);
    } finally {
      setFindingHooks(false);
    }
  }

  function applyHookSuggestion(suggestion: HookSuggestion) {
    onChange({
      ...draft,
      trim_start: suggestion.start_ms / 1000,
      trim_end: suggestion.end_ms / 1000,
      title_text: suggestion.title,
    });
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
        {segmentKey}
      </legend>

      <div className="grid gap-3 sm:grid-cols-2">
        <select
          value={draft.video_asset_id}
          onChange={(e) => onChange({ ...draft, video_asset_id: e.target.value })}
          className={selectClass}
        >
          <option value="">Select footage</option>
          {assets
            .filter((a) => a.asset_type === "footage")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.file_path.split("/").pop()}
              </option>
            ))}
        </select>

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

      {asset && asset.analysis_status === "done" && (
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
              {hookSuggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => applyHookSuggestion(s)}
                  className="rounded-lg border border-orange-200 bg-white p-3 text-left transition hover:border-orange-400 hover:bg-orange-50"
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
        <input
          type="text"
          placeholder="Title text (optional)"
          value={draft.title_text ?? ""}
          onChange={(e) => onChange({ ...draft, title_text: e.target.value })}
          className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
        />

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
    </fieldset>
  );
}
