"use client";

import { useEffect, useRef, useState } from "react";
import { CropRect } from "../lib/apiClient";

export function CropCanvas({
  imageSrc,
  label,
  initialRect,
  onChange,
}: {
  imageSrc: string;
  label: string;
  initialRect?: CropRect | null;
  onChange: (rect: CropRect) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);

  useEffect(() => {
    if (initialRect) {
      setRect(initialRect);
      onChange(initialRect);
    }
    // Only re-run when the suggestion itself changes (by reference), not on
    // every parent re-render -- onChange is intentionally excluded from deps
    // since it's a fresh closure each render in the current SegmentEditor usage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRect]);

  function relativePos(e: React.MouseEvent): { x: number; y: number } {
    const bounds = containerRef.current!.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) {
      return { x: 0, y: 0 };
    }
    return {
      x: (e.clientX - bounds.left) / bounds.width,
      y: (e.clientY - bounds.top) / bounds.height,
    };
  }

  function handleMouseDown(e: React.MouseEvent) {
    setStart(relativePos(e));
  }

  function handleMouseUp(e: React.MouseEvent) {
    if (!start) return;
    const end = relativePos(e);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const newRect: CropRect = {
      x: clamp(Math.min(start.x, end.x)),
      y: clamp(Math.min(start.y, end.y)),
      width: clamp(Math.abs(end.x - start.x)),
      height: clamp(Math.abs(end.y - start.y)),
    };
    setRect(newRect);
    onChange(newRect);
    setStart(null);
  }

  return (
    <div>
      <p>{label}</p>
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        style={{ position: "relative", width: "100%", cursor: "crosshair" }}
      >
        <video
          src={imageSrc}
          muted
          playsInline
          style={{ width: "100%", display: "block" }}
          onLoadedMetadata={(e) => {
            // ensure a frame is visible for drawing reference
            (e.target as HTMLVideoElement).currentTime = 0.1;
          }}
        />
        {rect && (
          <div
            style={{
              position: "absolute",
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              border: "2px solid red",
            }}
          />
        )}
      </div>
    </div>
  );
}
