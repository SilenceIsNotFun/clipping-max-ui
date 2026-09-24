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
    <div>
      <video ref={videoRef} src={src} controls style={{ width: "100%" }} />
      <div style={{ position: "relative", height: 24, background: "#ddd" }}>
        {moments.map((m) => (
          <button
            key={m.id}
            type="button"
            title={`${m.detection_type} (${m.score.toFixed(2)})`}
            onClick={() => jumpTo(m.timestamp_ms / 1000)}
            style={{
              position: "absolute",
              left: `${(m.timestamp_ms / 1000 / durationSeconds) * 100}%`,
              width: 4,
              height: "100%",
              background: m.detection_type === "audio_peak" ? "orange" : "purple",
              border: "none",
            }}
          />
        ))}
      </div>
      <button type="button" onClick={setInPoint}>
        Set In ({trimStart.toFixed(1)}s)
      </button>
      <button type="button" onClick={setOutPoint}>
        Set Out ({trimEnd.toFixed(1)}s)
      </button>
    </div>
  );
}
