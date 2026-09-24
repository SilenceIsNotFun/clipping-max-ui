"use client";

import { useRef, useState } from "react";
import { CropRect } from "../lib/apiClient";

export function CropCanvas({
  imageSrc,
  label,
  onChange,
}: {
  imageSrc: string;
  label: string;
  onChange: (rect: CropRect) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);

  function relativePos(e: React.MouseEvent): { x: number; y: number } {
    const bounds = containerRef.current!.getBoundingClientRect();
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
    const newRect: CropRect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
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
        <img src={imageSrc} alt={label} style={{ width: "100%", display: "block" }} />
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
