"use client";

import { useRef, useState } from "react";
import { MomentCandidate } from "../lib/apiClient";

export function TimelineScrubber({
  src,
  durationSeconds,
  moments,
  trimStart,
  trimEnd,
  onChange,
}: {
  src: string;
  durationSeconds: number;
  moments: MomentCandidate[];
  trimStart: number;
  trimEnd: number;
  onChange: (start: number, end: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  function jumpTo(seconds: number) {
    if (videoRef.current) videoRef.current.currentTime = seconds;
  }

  function setInPoint() {
    const current = videoRef.current?.currentTime ?? 0;
    onChange(current, trimEnd);
  }

  function setOutPoint() {
    const current = videoRef.current?.currentTime ?? durationSeconds;
    onChange(trimStart, current);
  }

  return (
    <div className="flex flex-col gap-2">
      <video ref={videoRef} src={src} controls className="rounded-lg" style={{ width: "100%" }} />
      <div className="rounded-full" style={{ position: "relative", height: 24, background: "#f1e9ff" }}>
        {moments.map((m) => (
          <button
            key={m.id}
            type="button"
            title={`${m.detection_type} (${m.score.toFixed(2)})`}
            onClick={() => jumpTo(m.timestamp_ms / 1000)}
            className="rounded-full"
            style={{
              position: "absolute",
              left: `${(m.timestamp_ms / 1000 / durationSeconds) * 100}%`,
              width: 4,
              height: "100%",
              background: m.detection_type === "audio_peak" ? "#f97316" : "#8b5cf6",
              border: "none",
            }}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={setInPoint}
          className="rounded-lg bg-purple-100 px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-200"
        >
          Set In ({trimStart.toFixed(1)}s)
        </button>
        <button
          type="button"
          onClick={setOutPoint}
          className="rounded-lg bg-pink-100 px-3 py-1.5 text-xs font-semibold text-pink-700 hover:bg-pink-200"
        >
          Set Out ({trimEnd.toFixed(1)}s)
        </button>
      </div>
    </div>
  );
}
