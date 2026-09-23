"use client";

import { useState } from "react";
import { Campaign } from "../lib/apiClient";
import { UploadForm } from "../components/UploadForm";

export default function HomePage() {
  const [lastUploaded, setLastUploaded] = useState<Campaign | null>(null);

  return (
    <main>
      <h1>ContentRewardFarm</h1>
      <UploadForm onUploaded={setLastUploaded} />
      {lastUploaded && <p>Uploaded: {lastUploaded.title} ({lastUploaded.status})</p>}
    </main>
  );
}
