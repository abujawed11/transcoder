"use client";

import { useState, useRef, useCallback, DragEvent } from "react";

const CHUNK_SIZE = 10 * 1024 * 1024;
const PARALLEL_UPLOADS = 4;
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
  const [isDragging, setIsDragging] = useState(false);
  const abortControllers = useRef<Map<string, AbortController>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateFileState = useCallback((id: string, updates: Partial<FileUploadState>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  }, []);

  async function uploadChunk(
    url: string,
    chunk: Blob,
    onProgress: (loaded: number) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
      xhr.onload = () => {
        if (xhr.status === 200) {
          resolve(xhr.getResponseHeader("ETag") || "");
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

  async function uploadSingleFile(fileState: FileUploadState): Promise<void> {
    const { id, file } = fileState;
    const controller = new AbortController();
    abortControllers.current.set(id, controller);

    try {
      updateFileState(id, { status: "uploading", message: "Initializing..." });

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);

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

      const partNumbers = Array.from({ length: totalChunks }, (_, i) => i + 1);
      const presignRes = await fetch("/api/multipart/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, uploadId, partNumbers }),
      });

      if (!presignRes.ok) throw new Error("Failed to get presigned URLs");
      const { presignedUrls } = await presignRes.json();

      const completedParts: { PartNumber: number; ETag: string }[] = [];
      const chunkProgress: number[] = new Array(totalChunks).fill(0);

      const updateProgress = () => {
        const totalUploaded = chunkProgress.reduce((sum, p) => sum + p, 0);
        const percent = Math.round((totalUploaded / file.size) * 100);
        const uploadedMB = (totalUploaded / (1024 * 1024)).toFixed(1);
        updateFileState(id, {
          progress: percent,
          message: `${uploadedMB} MB / ${fileSizeMB} MB`,
        });
      };

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

      updateFileState(id, { message: "Finalizing..." });

      const completeRes = await fetch("/api/multipart/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, uploadId, parts: completedParts }),
      });

      if (!completeRes.ok) throw new Error("Failed to complete upload");

      updateFileState(id, { message: "Queuing transcode..." });

      const jobRes = await fetch("/api/submit-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      updateFileState(id, {
        status: "completed",
        progress: 100,
        message: jobRes.ok ? "Queued for transcoding" : "Upload complete (queue failed)",
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

  function addFiles(fileList: FileList | File[]) {
    const videoFiles = Array.from(fileList).filter(f =>
      f.type.startsWith("video/") || /\.(mp4|mkv|avi|mov|webm|flv|wmv)$/i.test(f.name)
    );

    if (videoFiles.length === 0) return;

    const newFiles: FileUploadState[] = videoFiles.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file,
      status: "pending" as FileUploadStatus,
      progress: 0,
      message: "Ready to upload",
    }));

    setFiles(prev => [...prev, ...newFiles]);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }

  async function handleUploadAll() {
    const pendingFiles = files.filter(f => f.status === "pending");
    if (pendingFiles.length === 0) return;

    setIsUploading(true);

    const queue = [...pendingFiles];
    const activeUploads: Promise<void>[] = [];

    while (queue.length > 0 || activeUploads.length > 0) {
      while (queue.length > 0 && activeUploads.length < MAX_CONCURRENT_FILES) {
        const fileState = queue.shift()!;
        const uploadPromise = uploadSingleFile(fileState).then(() => {
          const index = activeUploads.indexOf(uploadPromise);
          if (index > -1) activeUploads.splice(index, 1);
        });
        activeUploads.push(uploadPromise);
      }
      if (activeUploads.length > 0) await Promise.race(activeUploads);
    }

    setIsUploading(false);
  }

  function removeFile(id: string) {
    const controller = abortControllers.current.get(id);
    if (controller) controller.abort();
    setFiles(prev => prev.filter(f => f.id !== id));
  }

  function clearCompleted() {
    setFiles(prev => prev.filter(f => f.status === "pending" || f.status === "uploading"));
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function truncateFilename(name: string, maxLength: number = 40): string {
    if (name.length <= maxLength) return name;
    const ext = name.split('.').pop() || '';
    const nameWithoutExt = name.slice(0, name.length - ext.length - 1);
    const truncatedName = nameWithoutExt.slice(0, maxLength - ext.length - 4) + '...';
    return `${truncatedName}.${ext}`;
  }

  const pendingCount = files.filter(f => f.status === "pending").length;
  const uploadingCount = files.filter(f => f.status === "uploading").length;
  const completedCount = files.filter(f => f.status === "completed").length;
  const errorCount = files.filter(f => f.status === "error").length;

  return (
    <>
      <style jsx global>{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%);
          min-height: 100vh;
          color: #e4e4e7;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes progressStripe {
          0% { background-position: 0 0; }
          100% { background-position: 40px 0; }
        }
      `}</style>

      <main style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: "40px 20px",
      }}>
        {/* Header */}
        <div style={{ marginBottom: 32, textAlign: "center" }}>
          <h1 style={{
            fontSize: 28,
            fontWeight: 700,
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            marginBottom: 8,
          }}>
            Video Transcoder
          </h1>
          <p style={{ color: "#71717a", fontSize: 14 }}>
            Upload videos for multi-quality transcoding
          </p>
        </div>

        {/* Drop Zone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${isDragging ? "#667eea" : "#3f3f46"}`,
            borderRadius: 16,
            padding: "48px 24px",
            textAlign: "center",
            cursor: "pointer",
            transition: "all 0.2s ease",
            background: isDragging ? "rgba(102, 126, 234, 0.1)" : "rgba(39, 39, 42, 0.5)",
            marginBottom: 24,
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
          <div style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 16px",
            fontSize: 28,
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>
            {isDragging ? "Drop videos here" : "Drag & drop videos here"}
          </p>
          <p style={{ color: "#71717a", fontSize: 13 }}>
            or click to browse • MP4, MKV, AVI, MOV supported
          </p>
        </div>

        {/* Action Bar */}
        {files.length > 0 && (
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 20,
            flexWrap: "wrap",
            gap: 12,
          }}>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={handleUploadAll}
                disabled={pendingCount === 0 || isUploading}
                style={{
                  padding: "12px 24px",
                  fontSize: 14,
                  fontWeight: 600,
                  background: pendingCount === 0 || isUploading
                    ? "#3f3f46"
                    : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                  color: pendingCount === 0 || isUploading ? "#71717a" : "white",
                  border: "none",
                  borderRadius: 10,
                  cursor: pendingCount === 0 || isUploading ? "not-allowed" : "pointer",
                  transition: "all 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {isUploading ? (
                  <>
                    <span style={{ animation: "pulse 1.5s infinite" }}>Uploading...</span>
                    <span style={{
                      background: "rgba(255,255,255,0.2)",
                      padding: "2px 8px",
                      borderRadius: 6,
                      fontSize: 12,
                    }}>
                      {uploadingCount}/{pendingCount + uploadingCount}
                    </span>
                  </>
                ) : (
                  <>
                    Start Upload
                    {pendingCount > 0 && (
                      <span style={{
                        background: "rgba(255,255,255,0.2)",
                        padding: "2px 8px",
                        borderRadius: 6,
                        fontSize: 12,
                      }}>
                        {pendingCount}
                      </span>
                    )}
                  </>
                )}
              </button>

              {(completedCount > 0 || errorCount > 0) && (
                <button
                  onClick={clearCompleted}
                  style={{
                    padding: "12px 20px",
                    fontSize: 14,
                    fontWeight: 500,
                    background: "transparent",
                    color: "#a1a1aa",
                    border: "1px solid #3f3f46",
                    borderRadius: 10,
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                  }}
                >
                  Clear Done
                </button>
              )}
            </div>

            {/* Status Pills */}
            <div style={{ display: "flex", gap: 8 }}>
              {pendingCount > 0 && (
                <span style={{
                  padding: "6px 12px",
                  background: "rgba(113, 113, 122, 0.2)",
                  borderRadius: 20,
                  fontSize: 12,
                  color: "#a1a1aa",
                }}>
                  {pendingCount} pending
                </span>
              )}
              {uploadingCount > 0 && (
                <span style={{
                  padding: "6px 12px",
                  background: "rgba(102, 126, 234, 0.2)",
                  borderRadius: 20,
                  fontSize: 12,
                  color: "#667eea",
                }}>
                  {uploadingCount} uploading
                </span>
              )}
              {completedCount > 0 && (
                <span style={{
                  padding: "6px 12px",
                  background: "rgba(34, 197, 94, 0.2)",
                  borderRadius: 20,
                  fontSize: 12,
                  color: "#22c55e",
                }}>
                  {completedCount} complete
                </span>
              )}
              {errorCount > 0 && (
                <span style={{
                  padding: "6px 12px",
                  background: "rgba(239, 68, 68, 0.2)",
                  borderRadius: 20,
                  fontSize: 12,
                  color: "#ef4444",
                }}>
                  {errorCount} failed
                </span>
              )}
            </div>
          </div>
        )}

        {/* File List */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {files.map((fileState, index) => (
            <div
              key={fileState.id}
              style={{
                background: "rgba(39, 39, 42, 0.6)",
                backdropFilter: "blur(10px)",
                borderRadius: 12,
                padding: 16,
                border: "1px solid",
                borderColor: fileState.status === "error" ? "rgba(239, 68, 68, 0.3)"
                  : fileState.status === "completed" ? "rgba(34, 197, 94, 0.3)"
                  : fileState.status === "uploading" ? "rgba(102, 126, 234, 0.3)"
                  : "rgba(63, 63, 70, 0.5)",
                animation: "slideIn 0.3s ease",
                animationDelay: `${index * 0.05}s`,
                animationFillMode: "backwards",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                {/* Status Icon */}
                <div style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  background: fileState.status === "completed" ? "rgba(34, 197, 94, 0.15)"
                    : fileState.status === "error" ? "rgba(239, 68, 68, 0.15)"
                    : fileState.status === "uploading" ? "rgba(102, 126, 234, 0.15)"
                    : "rgba(113, 113, 122, 0.15)",
                }}>
                  {fileState.status === "completed" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : fileState.status === "error" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  ) : fileState.status === "uploading" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#667eea" strokeWidth="2.5" style={{ animation: "pulse 1s infinite" }}>
                      <polyline points="17 11 12 6 7 11" />
                      <line x1="12" y1="6" x2="12" y2="18" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                  )}
                </div>

                {/* File Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: "#e4e4e7",
                    marginBottom: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }} title={fileState.file.name}>
                    {truncateFilename(fileState.file.name)}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: "#71717a",
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}>
                    <span>{formatFileSize(fileState.file.size)}</span>
                    <span style={{ opacity: 0.4 }}>•</span>
                    <span>{Math.ceil(fileState.file.size / CHUNK_SIZE)} chunks</span>
                  </div>
                </div>

                {/* Remove Button */}
                {(fileState.status === "pending" || fileState.status === "completed" || fileState.status === "error") && (
                  <button
                    onClick={() => removeFile(fileState.id)}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: "transparent",
                      border: "1px solid #3f3f46",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "all 0.2s ease",
                      color: "#71717a",
                    }}
                    title="Remove"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Progress Bar */}
              {(fileState.status === "uploading" || fileState.status === "completed") && (
                <div style={{ marginTop: 12 }}>
                  <div style={{
                    height: 6,
                    background: "rgba(63, 63, 70, 0.5)",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}>
                    <div style={{
                      height: "100%",
                      width: `${fileState.progress}%`,
                      borderRadius: 3,
                      transition: "width 0.3s ease",
                      background: fileState.status === "completed"
                        ? "#22c55e"
                        : "linear-gradient(90deg, #667eea 0%, #764ba2 100%)",
                      backgroundSize: fileState.status === "uploading" ? "40px 40px" : undefined,
                      backgroundImage: fileState.status === "uploading"
                        ? "linear-gradient(45deg, rgba(255,255,255,0.1) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.1) 75%, transparent 75%, transparent)"
                        : undefined,
                      animation: fileState.status === "uploading" ? "progressStripe 1s linear infinite" : undefined,
                    }} />
                  </div>
                  <div style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 12,
                  }}>
                    <span style={{
                      color: fileState.status === "completed" ? "#22c55e"
                        : fileState.status === "error" ? "#ef4444"
                        : "#a1a1aa",
                    }}>
                      {fileState.message}
                    </span>
                    <span style={{ color: "#71717a" }}>{fileState.progress}%</span>
                  </div>
                </div>
              )}

              {/* Error/Pending Message */}
              {fileState.status === "error" && (
                <div style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: "#ef4444",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {fileState.message}
                </div>
              )}

              {fileState.status === "pending" && (
                <div style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: "#71717a",
                }}>
                  Waiting to upload...
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Empty State */}
        {files.length === 0 && (
          <div style={{
            textAlign: "center",
            padding: "60px 20px",
            color: "#52525b",
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: "0 auto 16px", opacity: 0.5 }}>
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <p style={{ fontSize: 15 }}>No videos selected</p>
            <p style={{ fontSize: 13, marginTop: 4, opacity: 0.7 }}>
              Drag files here or click to browse
            </p>
          </div>
        )}

        {/* Settings Info */}
        <div style={{
          marginTop: 32,
          padding: 16,
          background: "rgba(39, 39, 42, 0.4)",
          borderRadius: 12,
          fontSize: 13,
          color: "#71717a",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
              <span>Chunk: {formatFileSize(CHUNK_SIZE)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="17 1 21 5 17 9" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <polyline points="7 23 3 19 7 15" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
              <span>Parallel chunks: {PARALLEL_UPLOADS}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span>Concurrent files: {MAX_CONCURRENT_FILES}</span>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
