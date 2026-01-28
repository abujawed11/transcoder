"use client";

import { useState } from "react";

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string>("");

  async function handleUpload() {
    if (!file) return;

    try {
      setStatus("Requesting signed URL...");

      const res = await fetch("/api/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus(`Error: ${data.error}`);
        return;
      }

      const { url, key } = data as { url: string; key: string };

      setStatus("Uploading to MinIO...");

      const putRes = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });

      if (!putRes.ok) {
        setStatus(`Upload failed: ${putRes.status} ${putRes.statusText}`);
        return;
      }

      setStatus("Upload done. Queueing transcode job...");

      const jobRes = await fetch("/api/submit-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      const jobData = await jobRes.json();
      if (!jobRes.ok) {
        setStatus(`✅ Uploaded, but job queue failed: ${jobData.error}`);
        return;
      }

      setStatus(`✅ Uploaded + Queued! Object key: ${key}`);
    } catch (err: any) {
      setStatus(`Unexpected error: ${err?.message || String(err)}`);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Video Upload (MinIO Signed URL)</h1>

      <input
        type="file"
        accept="video/*"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <div style={{ marginTop: 12 }}>
        <button onClick={handleUpload} disabled={!file}>
          Upload
        </button>
      </div>

      <p style={{ marginTop: 12 }}>{status}</p>
    </main>
  );
}
