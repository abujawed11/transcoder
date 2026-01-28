"use client";

import { useState, useRef } from "react";

// 10MB chunk size (S3 minimum is 5MB for multipart, except last part)
const CHUNK_SIZE = 10 * 1024 * 1024;
// Upload 4 chunks in parallel
const PARALLEL_UPLOADS = 4;

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string>("");
  const [progress, setProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const abortController = useRef<AbortController | null>(null);

  async function uploadChunk(
    url: string,
    chunk: Blob,
    partNumber: number,
    onProgress: (loaded: number) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(e.loaded);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          // Get ETag from response header
          const etag = xhr.getResponseHeader("ETag");
          resolve(etag || "");
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error("Network error"));
      xhr.onabort = () => reject(new Error("Upload cancelled"));

      xhr.open("PUT", url);
      xhr.send(chunk);
    });
  }

  async function handleUpload() {
    if (!file) return;

    setIsUploading(true);
    setProgress(0);
    abortController.current = new AbortController();

    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);

      setStatus(`Preparing upload (${fileSizeMB} MB, ${totalChunks} chunks)...`);

      // Step 1: Initiate multipart upload
      const initRes = await fetch("/api/multipart/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
        }),
      });

      if (!initRes.ok) {
        throw new Error("Failed to initiate upload");
      }

      const { uploadId, key } = await initRes.json();
      console.log("Multipart upload initiated:", { uploadId, key });

      // Step 2: Get presigned URLs for all parts
      const partNumbers = Array.from({ length: totalChunks }, (_, i) => i + 1);

      const presignRes = await fetch("/api/multipart/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, uploadId, partNumbers }),
      });

      if (!presignRes.ok) {
        throw new Error("Failed to get presigned URLs");
      }

      const { presignedUrls } = await presignRes.json();

      // Step 3: Upload chunks in parallel with progress tracking
      setStatus(`Uploading ${totalChunks} chunks (${PARALLEL_UPLOADS} parallel)...`);

      const completedParts: { PartNumber: number; ETag: string }[] = [];
      const chunkProgress: number[] = new Array(totalChunks).fill(0);
      let totalUploaded = 0;

      const updateTotalProgress = () => {
        totalUploaded = chunkProgress.reduce((sum, p) => sum + p, 0);
        const percent = Math.round((totalUploaded / file.size) * 100);
        setProgress(percent);
        const uploadedMB = (totalUploaded / (1024 * 1024)).toFixed(2);
        setStatus(`Uploading: ${uploadedMB} / ${fileSizeMB} MB (${percent}%)`);
      };

      // Process chunks in batches for parallel upload
      for (let i = 0; i < totalChunks; i += PARALLEL_UPLOADS) {
        const batch = partNumbers.slice(i, i + PARALLEL_UPLOADS);

        const batchPromises = batch.map(async (partNumber) => {
          const start = (partNumber - 1) * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);
          const url = presignedUrls[partNumber];

          const etag = await uploadChunk(url, chunk, partNumber, (loaded) => {
            chunkProgress[partNumber - 1] = loaded;
            updateTotalProgress();
          });

          // Mark chunk as fully uploaded
          chunkProgress[partNumber - 1] = chunk.size;
          updateTotalProgress();

          return { PartNumber: partNumber, ETag: etag.replace(/"/g, "") };
        });

        const batchResults = await Promise.all(batchPromises);
        completedParts.push(...batchResults);
      }

      // Step 4: Complete multipart upload
      setStatus("Finalizing upload...");

      const completeRes = await fetch("/api/multipart/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          uploadId,
          parts: completedParts,
        }),
      });

      if (!completeRes.ok) {
        throw new Error("Failed to complete upload");
      }

      setProgress(100);
      console.log("Upload complete:", key);

      // Step 5: Queue transcode job
      setStatus("Queueing transcode job...");

      const jobRes = await fetch("/api/submit-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      if (!jobRes.ok) {
        setStatus(`✅ Uploaded, but job queue failed`);
        return;
      }

      setStatus(`✅ Upload complete! Transcoding queued for: ${key}`);
    } catch (err: any) {
      console.error("Upload error:", err);
      setStatus(`❌ Error: ${err?.message || "Upload failed"}`);
      setProgress(0);
    } finally {
      setIsUploading(false);
      abortController.current = null;
    }
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 600 }}>
      <h1>Video Upload (S3 Multipart)</h1>

      <div style={{ marginBottom: 16 }}>
        <input
          type="file"
          accept="video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={isUploading}
        />
      </div>

      {file && (
        <div style={{ marginBottom: 16, padding: 12, background: "#f5f5f5", borderRadius: 4 }}>
          <strong>{file.name}</strong>
          <br />
          <span style={{ color: "#666" }}>
            Size: {formatFileSize(file.size)} |
            Type: {file.type || "unknown"} |
            Chunks: {Math.ceil(file.size / CHUNK_SIZE)}
          </span>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <button
          onClick={handleUpload}
          disabled={!file || isUploading}
          style={{
            padding: "10px 20px",
            fontSize: 16,
            cursor: !file || isUploading ? "not-allowed" : "pointer",
          }}
        >
          {isUploading ? "Uploading..." : "Upload"}
        </button>
      </div>

      {/* Progress Bar */}
      {isUploading && (
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              width: "100%",
              height: 24,
              background: "#e0e0e0",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: progress === 100 ? "#4caf50" : "#2196f3",
                transition: "width 0.2s ease",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontWeight: "bold",
                fontSize: 12,
              }}
            >
              {progress > 5 ? `${progress}%` : ""}
            </div>
          </div>
        </div>
      )}

      <p style={{ marginTop: 12, minHeight: 24 }}>{status}</p>

      <hr style={{ margin: "24px 0" }} />

      <div style={{ fontSize: 14, color: "#666" }}>
        <strong>Upload Settings:</strong>
        <ul>
          <li>Chunk size: {formatFileSize(CHUNK_SIZE)}</li>
          <li>Parallel uploads: {PARALLEL_UPLOADS}</li>
          <li>Storage: MinIO (local)</li>
        </ul>
      </div>
    </main>
  );
}
