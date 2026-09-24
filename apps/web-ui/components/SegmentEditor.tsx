"use client";

import { useEffect, useState } from "react";
import {
  CropRect,
  LayoutTemplate,
  MomentCandidate,
  SegmentDraft,
  VideoAsset,
  listMoments,
} from "../lib/apiClient";
import { TimelineScrubber } from "./TimelineScrubber";
import { CropCanvas } from "./CropCanvas";

const TEMPLATES: LayoutTemplate[] = [
  "standard",
  "gameplay_facecam_split",
  "gameplay_full_focus",
  "cinematic_letterbox",
];

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
  const asset = assets.find((a) => a.id === draft.video_asset_id);

  useEffect(() => {
    if (draft.video_asset_id) {
      listMoments(campaignId, draft.video_asset_id).then(setMoments);
    }
  }, [campaignId, draft.video_asset_id]);

  const needsGameplayCrop =
    !draft.secondary_video_asset_id &&
    (draft.layout_template === "gameplay_full_focus" || draft.layout_template === "gameplay_facecam_split");
  const needsFacecamCrop = !draft.secondary_video_asset_id && draft.layout_template === "gameplay_facecam_split";

  return (
    <fieldset>
      <legend>{segmentKey}</legend>

      <select
        value={draft.video_asset_id}
        onChange={(e) => onChange({ ...draft, video_asset_id: e.target.value })}
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
      >
        {TEMPLATES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      {asset && (
        <TimelineScrubber
          src={`/media/${asset.file_path}`}
          durationSeconds={asset.duration_seconds}
          moments={moments}
          trimStart={draft.trim_start}
          trimEnd={draft.trim_end}
          onChange={(start, end) => onChange({ ...draft, trim_start: start, trim_end: end })}
        />
      )}

      {needsGameplayCrop && asset && (
        <CropCanvas
          imageSrc={`/media/${asset.file_path}`}
          label="Gameplay area"
          onChange={(rect: CropRect) => onChange({ ...draft, crop_gameplay_rect: rect })}
        />
      )}
      {needsFacecamCrop && asset && (
        <CropCanvas
          imageSrc={`/media/${asset.file_path}`}
          label="Facecam area"
          onChange={(rect: CropRect) => onChange({ ...draft, crop_facecam_rect: rect })}
        />
      )}

      <input
        type="text"
        placeholder="Title text (optional)"
        value={draft.title_text ?? ""}
        onChange={(e) => onChange({ ...draft, title_text: e.target.value })}
      />
    </fieldset>
  );
}
