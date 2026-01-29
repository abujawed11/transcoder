"use client";

import { useState, useRef, useCallback } from "react";

// 10MB chunk size (S3 minimum is 5MB for multipart, except last part)
const CHUNK_SIZE = 10 * 1024 * 1024;
// Upload 4 chunks in parallel per file
const PARALLEL_UPLOADS = 4;
// Max concurrent file uploads
const MAX_CONCURRENT_FILES = 3;

type FileUploadStatus = "pending" | "uploading" | "completed" | "error";

interface FileUploadState {
  id: string;
  file: File;
  status: FileUploadStatus;
  progress: number;
  message: string;
  error?: string;
}

export default function HomePage() {
  const [files, setFiles] = useState<FileUploadState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  // Update a specific file's state
  const updateFileState = useCallback((id: string, updates: Partial<FileUploadState>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  }, []);

  // Upload a single chunk
  async function uploadChunk(
    url: string,
    chunk: Blob,
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

  // Upload a single file
  async function uploadSingleFile(fileState: FileUploadState): Promise<void> {
    const { id, file } = fileState;
    const controller = new AbortController();
    abortControllers.current.set(id, controller);

    try {
      updateFileState(id, { status: "uploading", message: "Preparing upload..." });

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);

      // Step 1: Initiate multipart upload
      const initRes = await fetch("/api/multipart/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
        }),
      });

      if (!initRes.ok) throw new Error("Failed to initiate upload");

      const { uploadId, key } = await initRes.json();

      // Step 2: Get presigned URLs for all parts
      const partNumbers = Array.from({ length: totalChunks }, (_, i) => i + 1);

      const presignRes = await fetch("/api/multipart/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, uploadId, partNumbers }),
      });

      if (!presignRes.ok) throw new Error("Failed to get presigned URLs");

      const { presignedUrls } = await presignRes.json();

      // Step 3: Upload chunks in parallel with progress tracking
      const completedParts: { PartNumber: number; ETag: string }[] = [];
      const chunkProgress: number[] = new Array(totalChunks).fill(0);

      const updateProgress = () => {
        const totalUploaded = chunkProgress.reduce((sum, p) => sum + p, 0);
        const percent = Math.round((totalUploaded / file.size) * 100);
        const uploadedMB = (totalUploaded / (1024 * 1024)).toFixed(2);
        updateFileState(id, {
          progress: percent,
          message: `Uploading: ${uploadedMB} / ${fileSizeMB} MB`,
        });
      };

      // Process chunks in batches
      for (let i = 0; i < totalChunks; i += PARALLEL_UPLOADS) {
        const batch = partNumbers.slice(i, i + PARALLEL_UPLOADS);

        const batchPromises = batch.map(async (partNumber) => {
          const start = (partNumber - 1) * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);
          const url = presignedUrls[partNumber];

          const etag = await uploadChunk(url, chunk, (loaded) => {
            chunkProgress[partNumber - 1] = loaded;
            updateProgress();
          });

          chunkProgress[partNumber - 1] = chunk.size;
          updateProgress();

          return { PartNumber: partNumber, ETag: etag.replace(/"/g, "") };
        });

        const batchResults = await Promise.all(batchPromises);
        completedParts.push(...batchResults);
      }

      // Step 4: Complete multipart upload
      updateFileState(id, { message: "Finalizing upload..." });

      const completeRes = await fetch("/api/multipart/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, uploadId, parts: completedParts }),
      });

      if (!completeRes.ok) throw new Error("Failed to complete upload");

      // Step 5: Queue transcode job
      updateFileState(id, { message: "Queueing transcode job..." });

      const jobRes = await fetch("/api/submit-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      if (!jobRes.ok) {
        updateFileState(id, {
          status: "completed",
          progress: 100,
          message: "Uploaded, but job queue failed",
        });
        return;
      }

      updateFileState(id, {
        status: "completed",
        progress: 100,
        message: `Transcoding queued: ${key}`,
      });
    } catch (err: any) {
      console.error(`Upload error for ${file.name}:`, err);
      updateFileState(id, {
        status: "error",
        progress: 0,
        message: err?.message || "Upload failed",
        error: err?.message,
      });
    } finally {
      abortControllers.current.delete(id);
    }
  }

  // Handle file selection
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    const newFiles: FileUploadState[] = Array.from(selectedFiles).map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file,
      status: "pending" as FileUploadStatus,
      progress: 0,
      message: "Ready to upload",
    }));

    setFiles(prev => [...prev, ...newFiles]);
    e.target.value = ""; // Reset input to allow selecting same files again
  }

  // Upload all pending files with concurrency limit
  async function handleUploadAll() {
    const pendingFiles = files.filter(f => f.status === "pending");
    if (pendingFiles.length === 0) return;

    setIsUploading(true);

    // Process files with concurrency limit
    const queue = [...pendingFiles];
    const activeUploads: Promise<void>[] = [];

    while (queue.length > 0 || activeUploads.length > 0) {
      // Start new uploads up to the concurrency limit
      while (queue.length > 0 && activeUploads.length < MAX_CONCURRENT_FILES) {
        const fileState = queue.shift()!;
        const uploadPromise = uploadSingleFile(fileState).then(() => {
          // Remove from active uploads when done
          const index = activeUploads.indexOf(uploadPromise);
          if (index > -1) activeUploads.splice(index, 1);
        });
        activeUploads.push(uploadPromise);
      }

      // Wait for at least one upload to complete
      if (activeUploads.length > 0) {
        await Promise.race(activeUploads);
      }
    }

    setIsUploading(false);
  }

  // Remove a file from the list
  function removeFile(id: string) {
    const controller = abortControllers.current.get(id);
    if (controller) controller.abort();
    setFiles(prev => prev.filter(f => f.id !== id));
  }

  // Clear completed/errored files
  function clearCompleted() {
    setFiles(prev => prev.filter(f => f.status === "pending" || f.status === "uploading"));
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function getStatusColor(status: FileUploadStatus): string {
    switch (status) {
      case "pending": return "#9e9e9e";
      case "uploading": return "#2196f3";
      case "completed": return "#4caf50";
      case "error": return "#f44336";
    }
  }

  function getStatusIcon(status: FileUploadStatus): string {
    switch (status) {
      case "pending": return "○";
      case "uploading": return "↑";
      case "completed": return "✓";
      case "error": return "✗";
    }
  }

  const pendingCount = files.filter(f => f.status === "pending").length;
  const uploadingCount = files.filter(f => f.status === "uploading").length;
  const completedCount = files.filter(f => f.status === "completed").length;
  const errorCount = files.filter(f => f.status === "error").length;

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 700 }}>
      <h1>Video Upload (S3 Multipart)</h1>

      {/* File Input */}
      <div style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center" }}>
        <label
          style={{
            padding: "10px 20px",
            background: "#f0f0f0",
            borderRadius: 4,
            cursor: "pointer",
            border: "2px dashed #ccc",
          }}
        >
          + Select Videos
          <input
            type="file"
            accept="video/*"
            multiple
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
        </label>
        <span style={{ color: "#666", fontSize: 14 }}>
          {files.length > 0 ? `${files.length} file(s) selected` : "No files selected"}
        </span>
      </div>

      {/* Action Buttons */}
      {files.length > 0 && (
        <div style={{ marginBottom: 16, display: "flex", gap: 12 }}>
          <button
            onClick={handleUploadAll}
            disabled={pendingCount === 0 || isUploading}
            style={{
              padding: "10px 20px",
              fontSize: 16,
              background: pendingCount === 0 || isUploading ? "#ccc" : "#2196f3",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: pendingCount === 0 || isUploading ? "not-allowed" : "pointer",
            }}
          >
            {isUploading ? `Uploading (${uploadingCount}/${pendingCount + uploadingCount})...` : `Upload All (${pendingCount})`}
          </button>
          {(completedCount > 0 || errorCount > 0) && (
            <button
              onClick={clearCompleted}
              style={{
                padding: "10px 20px",
                fontSize: 16,
                background: "#f5f5f5",
                border: "1px solid #ccc",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Clear Completed
            </button>
          )}
        </div>
      )}

      {/* Status Summary */}
      {files.length > 0 && (
        <div style={{ marginBottom: 16, fontSize: 14, color: "#666" }}>
          <span style={{ marginRight: 16 }}>○ Pending: {pendingCount}</span>
          <span style={{ marginRight: 16, color: "#2196f3" }}>↑ Uploading: {uploadingCount}</span>
          <span style={{ marginRight: 16, color: "#4caf50" }}>✓ Completed: {completedCount}</span>
          {errorCount > 0 && <span style={{ color: "#f44336" }}>✗ Errors: {errorCount}</span>}
        </div>
      )}

      {/* File List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {files.map((fileState) => (
          <div
            key={fileState.id}
            style={{
              padding: 12,
              background: "#f9f9f9",
              borderRadius: 4,
              border: `1px solid ${getStatusColor(fileState.status)}40`,
              borderLeft: `4px solid ${getStatusColor(fileState.status)}`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: getStatusColor(fileState.status), fontWeight: "bold" }}>
                    {getStatusIcon(fileState.status)}
                  </span>
                  <strong style={{ wordBreak: "break-all" }}>{fileState.file.name}</strong>
                </div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                  {formatFileSize(fileState.file.size)} | {Math.ceil(fileState.file.size / CHUNK_SIZE)} chunks
                </div>
              </div>
              {(fileState.status === "pending" || fileState.status === "completed" || fileState.status === "error") && (
                <button
                  onClick={() => removeFile(fileState.id)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontSize: 18,
                    color: "#999",
                    padding: "0 4px",
                  }}
                  title="Remove"
                >
                  ×
                </button>
              )}
            </div>

            {/* Progress Bar */}
            {(fileState.status === "uploading" || fileState.status === "completed") && (
              <div
                style={{
                  marginTop: 8,
                  width: "100%",
                  height: 20,
                  background: "#e0e0e0",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${fileState.progress}%`,
                    height: "100%",
                    background: fileState.status === "completed" ? "#4caf50" : "#2196f3",
                    transition: "width 0.2s ease",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "white",
                    fontWeight: "bold",
                    fontSize: 11,
                  }}
                >
                  {fileState.progress > 10 ? `${fileState.progress}%` : ""}
                </div>
              </div>
            )}

            {/* Status Message */}
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: fileState.status === "error" ? "#f44336" : "#666",
              }}
            >
              {fileState.message}
            </div>
          </div>
        ))}
      </div>

      {files.length === 0 && (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            background: "#f9f9f9",
            borderRadius: 8,
            border: "2px dashed #ddd",
            color: "#999",
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 8 }}>🎬</div>
          <div>Select video files to upload</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Multiple files supported</div>
        </div>
      )}

      <hr style={{ margin: "24px 0" }} />

      <div style={{ fontSize: 14, color: "#666" }}>
        <strong>Upload Settings:</strong>
        <ul>
          <li>Chunk size: {formatFileSize(CHUNK_SIZE)}</li>
          <li>Parallel chunk uploads: {PARALLEL_UPLOADS}</li>
          <li>Concurrent file uploads: {MAX_CONCURRENT_FILES}</li>
          <li>Storage: MinIO (local)</li>
        </ul>
      </div>
    </main>
  );
}
