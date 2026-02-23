"use client";

import { useState, useRef, useCallback, useEffect, DragEvent } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4001";

const CHUNK_SIZE = 10 * 1024 * 1024;
const PARALLEL_UPLOADS = 4;
const MAX_CONCURRENT_FILES = 3;
const JOB_POLL_INTERVAL = 2000;

type FileUploadStatus = "pending" | "uploading" | "uploaded" | "transcoding" | "completed" | "error" | "cancelled";

interface FileUploadState {
  id: string;
  file: File;
  status: FileUploadStatus;
  progress: number;
  message: string;
  error?: string;
  jobId?: string;
  transcodeProgress?: number;
}

interface WsProgress {
  jobId: string;
  stage: "download" | "analyze" | "encode" | "upload" | "done" | "error";
  rendition?: string;
  percent: number;
  speed?: string;
  fps?: number;
  message?: string;
  ts: number;
}

interface TranscodeSettings {
  crf: number;
  ffmpegPreset: string;
  qualities: string[];
  parallelEncodes: number;
}

const DEFAULT_SETTINGS: TranscodeSettings = {
  crf: 23,
  ffmpegPreset: "fast",
  qualities: ["1080p", "720p", "480p", "360p"],
  parallelEncodes: 2,
};

const PRESET_INFO: Record<string, { speed: string; size: string; desc: string }> = {
  ultrafast: { speed: "10x", size: "+80%", desc: "Fastest encoding, largest files" },
  veryfast: { speed: "5x", size: "+40%", desc: "Very fast, larger files" },
  fast: { speed: "3x", size: "+15%", desc: "Good balance of speed and size" },
  medium: { speed: "1x", size: "Baseline", desc: "Default FFmpeg preset" },
  slow: { speed: "0.5x", size: "-15%", desc: "Slower, smaller files" },
  slower: { speed: "0.25x", size: "-20%", desc: "Much slower, best compression" },
};

const QUALITY_INFO: Record<string, string> = {
  "1080p": "Full HD (1920x1080)",
  "720p": "HD (1280x720)",
  "480p": "SD (854x480)",
  "360p": "Low (640x360)",
};

export default function HomePage() {
  const [files, setFiles] = useState<FileUploadState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<TranscodeSettings>(DEFAULT_SETTINGS);
  const abortControllers = useRef<Map<string, AbortController>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Live progress received from the WebSocket server
  const [wsProgress, setWsProgress] = useState<Map<string, WsProgress>>(new Map());
  const wsConnections = useRef<Map<string, WebSocket>>(new Map());
  const wsReconnectTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Ref so WS callbacks always see the latest files without stale closures
  const filesRef = useRef<FileUploadState[]>([]);

  // Load settings from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("transcodeSettings");
    if (saved) {
      try {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
      } catch (e) {
        console.error("Failed to load settings:", e);
      }
    }
  }, []);

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem("transcodeSettings", JSON.stringify(settings));
  }, [settings]);

  const updateFileState = useCallback((id: string, updates: Partial<FileUploadState>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  }, []);

  // Poll for job statuses
  useEffect(() => {
    const pollJobStatuses = async () => {
      const transcodingFiles = files.filter(f => f.status === "transcoding" && f.jobId);
      if (transcodingFiles.length === 0) return;

      const jobIds = transcodingFiles.map(f => f.jobId).join(",");

      try {
        const res = await fetch(`/api/jobs/status?ids=${jobIds}`);
        if (!res.ok) return;

        const { statuses } = await res.json();

        for (const file of transcodingFiles) {
          if (!file.jobId) continue;
          const jobStatus = statuses[file.jobId];
          if (!jobStatus) continue;

          if (jobStatus.state === "completed") {
            updateFileState(file.id, {
              status: "completed",
              transcodeProgress: 100,
              message: "Transcoding complete",
            });
          } else if (jobStatus.state === "failed") {
            const isCancelled = jobStatus.failedReason?.includes("Cancelled") ||
                               jobStatus.failedReason?.includes("cancelled") ||
                               jobStatus.failedReason === "CANCELLED";
            updateFileState(file.id, {
              status: isCancelled ? "cancelled" : "error",
              message: isCancelled ? "Transcoding cancelled" : (jobStatus.failedReason || "Transcoding failed"),
            });
          } else if (jobStatus.state === "active") {
            updateFileState(file.id, {
              transcodeProgress: jobStatus.progress || 0,
              message: `Transcoding: ${jobStatus.progress || 0}%`,
            });
          }
        }
      } catch (err) {
        console.error("Error polling job statuses:", err);
      }
    };

    pollingRef.current = setInterval(pollJobStatuses, JOB_POLL_INTERVAL);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [files, updateFileState]);

  // Keep filesRef in sync so WS reconnect closures always see current state
  filesRef.current = files;

  // Open/close WebSocket connections as jobs start and finish transcoding
  const connectWs = useCallback((jobId: string) => {
    const ws = new WebSocket(`${WS_URL}/ws/progress`);
    wsConnections.current.set(jobId, ws);

    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", jobId }));

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WsProgress;
        setWsProgress(prev => { const m = new Map(prev); m.set(jobId, payload); return m; });
      } catch { /* ignore malformed frames */ }
    };

    ws.onclose = () => {
      wsConnections.current.delete(jobId);
      // Reconnect after 2 s if the job is still active
      const timer = setTimeout(() => {
        wsReconnectTimers.current.delete(jobId);
        if (filesRef.current.some(f => f.jobId === jobId && f.status === "transcoding")) {
          connectWs(jobId);
        }
      }, 2000);
      wsReconnectTimers.current.set(jobId, timer);
    };

    ws.onerror = () => ws.close();
  }, []); // stable ref; all mutable state accessed via refs

  useEffect(() => {
    const activeJobIds = new Set(
      files.filter(f => f.status === "transcoding" && f.jobId).map(f => f.jobId!)
    );

    // Open connections for newly queued transcoding jobs
    for (const jobId of activeJobIds) {
      if (!wsConnections.current.has(jobId)) connectWs(jobId);
    }

    // Close and clean up connections for finished jobs
    for (const jobId of [...wsConnections.current.keys()]) {
      if (!activeJobIds.has(jobId)) {
        wsConnections.current.get(jobId)?.close();
        wsConnections.current.delete(jobId);
      }
    }
    for (const jobId of [...wsReconnectTimers.current.keys()]) {
      if (!activeJobIds.has(jobId)) {
        clearTimeout(wsReconnectTimers.current.get(jobId));
        wsReconnectTimers.current.delete(jobId);
      }
    }
  }, [files, connectWs]);

  // Global cleanup on unmount
  useEffect(() => {
    return () => {
      for (const ws of wsConnections.current.values()) ws.close();
      for (const timer of wsReconnectTimers.current.values()) clearTimeout(timer);
    };
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
          message: `Uploading: ${uploadedMB} / ${fileSizeMB} MB`,
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

      updateFileState(id, { status: "uploaded", progress: 100, message: "Finalizing upload..." });

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
        body: JSON.stringify({ key, settings }),
      });

      if (!jobRes.ok) {
        updateFileState(id, {
          status: "error",
          message: "Upload complete but failed to queue transcode",
        });
        return;
      }

      const { jobId } = await jobRes.json();

      updateFileState(id, {
        status: "transcoding",
        jobId,
        transcodeProgress: 0,
        message: "Queued for transcoding...",
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

  async function cancelJob(fileId: string, jobId: string) {
    try {
      updateFileState(fileId, { message: "Sending cancel signal..." });

      const res = await fetch(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
      });

      const data = await res.json();

      if (res.ok) {
        if (data.status === "cancelling") {
          updateFileState(fileId, {
            message: "Stopping... (will stop at next checkpoint)",
          });
        } else {
          updateFileState(fileId, {
            status: "cancelled",
            message: "Transcoding cancelled",
          });
        }
      } else {
        updateFileState(fileId, {
          message: data.error || "Failed to cancel",
        });
      }
    } catch (err: any) {
      console.error("Error cancelling job:", err);
      updateFileState(fileId, {
        message: "Failed to cancel: " + (err?.message || "Unknown error"),
      });
    }
  }

  async function cancelAllJobs() {
    try {
      const res = await fetch("/api/jobs/cancel-all", {
        method: "POST",
      });

      if (res.ok) {
        setFiles(prev => prev.map(f =>
          f.status === "transcoding"
            ? { ...f, status: "cancelled" as FileUploadStatus, message: "Transcoding cancelled" }
            : f
        ));
      }
    } catch (err) {
      console.error("Error cancelling all jobs:", err);
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
    setFiles(prev => prev.filter(f =>
      f.status === "pending" || f.status === "uploading" || f.status === "transcoding"
    ));
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

  function toggleQuality(quality: string) {
    setSettings(prev => ({
      ...prev,
      qualities: prev.qualities.includes(quality)
        ? prev.qualities.filter(q => q !== quality)
        : [...prev.qualities, quality],
    }));
  }

  const pendingCount = files.filter(f => f.status === "pending").length;
  const uploadingCount = files.filter(f => f.status === "uploading").length;
  const transcodingCount = files.filter(f => f.status === "transcoding").length;
  const completedCount = files.filter(f => f.status === "completed").length;
  const errorCount = files.filter(f => f.status === "error").length;
  const cancelledCount = files.filter(f => f.status === "cancelled").length;

  return (
    <>
      <style jsx global>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%);
          min-height: 100vh;
          color: #e4e4e7;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes progressStripe { 0% { background-position: 0 0; } 100% { background-position: 40px 0; } }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      `}</style>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "40px 20px" }}>
        {/* Header */}
        <div style={{ marginBottom: 32, textAlign: "center" }}>
          <h1 style={{
            fontSize: 28, fontWeight: 700,
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            marginBottom: 8,
          }}>
            Video Transcoder
          </h1>
          <p style={{ color: "#71717a", fontSize: 14 }}>
            Upload videos for multi-quality transcoding
          </p>
        </div>

        {/* Settings Panel */}
        <div style={{
          background: "rgba(39, 39, 42, 0.6)",
          borderRadius: 12,
          marginBottom: 24,
          border: "1px solid rgba(63, 63, 70, 0.5)",
          overflow: "hidden",
        }}>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              width: "100%",
              padding: "16px 20px",
              background: "transparent",
              border: "none",
              color: "#e4e4e7",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
              Transcoding Settings
            </span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ transform: showSettings ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showSettings && (
            <div style={{ padding: "0 20px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Speed Preset */}
              <div>
                <label style={{ display: "block", marginBottom: 8, fontSize: 13, color: "#a1a1aa" }}>
                  Speed Preset
                  <span style={{ marginLeft: 8, color: "#71717a", fontSize: 12 }}>
                    (Faster = larger files)
                  </span>
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {Object.entries(PRESET_INFO).map(([preset, info]) => (
                    <button
                      key={preset}
                      onClick={() => setSettings(s => ({ ...s, ffmpegPreset: preset }))}
                      style={{
                        padding: "8px 16px",
                        borderRadius: 8,
                        border: settings.ffmpegPreset === preset
                          ? "2px solid #667eea"
                          : "1px solid #3f3f46",
                        background: settings.ffmpegPreset === preset
                          ? "rgba(102, 126, 234, 0.2)"
                          : "transparent",
                        color: settings.ffmpegPreset === preset ? "#667eea" : "#a1a1aa",
                        cursor: "pointer",
                        fontSize: 13,
                        transition: "all 0.2s",
                      }}
                      title={`${info.desc}\nSpeed: ${info.speed}\nFile size: ${info.size}`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: "#71717a" }}>
                  {PRESET_INFO[settings.ffmpegPreset]?.desc} •
                  Speed: {PRESET_INFO[settings.ffmpegPreset]?.speed} •
                  Size: {PRESET_INFO[settings.ffmpegPreset]?.size}
                </div>
              </div>

              {/* CRF Quality */}
              <div>
                <label style={{ display: "block", marginBottom: 8, fontSize: 13, color: "#a1a1aa" }}>
                  Quality (CRF): {settings.crf}
                  <span style={{ marginLeft: 8, color: "#71717a", fontSize: 12 }}>
                    (Lower = better quality, larger files)
                  </span>
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 12, color: "#71717a", width: 60 }}>Smaller</span>
                  <input
                    type="range"
                    min="18"
                    max="32"
                    value={settings.crf}
                    onChange={(e) => setSettings(s => ({ ...s, crf: Number(e.target.value) }))}
                    style={{ flex: 1, accentColor: "#667eea" }}
                  />
                  <span style={{ fontSize: 12, color: "#71717a", width: 60, textAlign: "right" }}>Better</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, color: "#52525b" }}>
                  <span>32 (Smallest)</span>
                  <span>23 (Default)</span>
                  <span>18 (Best)</span>
                </div>
              </div>

              {/* Output Qualities */}
              <div>
                <label style={{ display: "block", marginBottom: 8, fontSize: 13, color: "#a1a1aa" }}>
                  Output Resolutions
                  <span style={{ marginLeft: 8, color: "#71717a", fontSize: 12 }}>
                    (More = longer encoding time)
                  </span>
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {["1080p", "720p", "480p", "360p"].map((quality) => (
                    <button
                      key={quality}
                      onClick={() => toggleQuality(quality)}
                      style={{
                        padding: "8px 16px",
                        borderRadius: 8,
                        border: settings.qualities.includes(quality)
                          ? "2px solid #22c55e"
                          : "1px solid #3f3f46",
                        background: settings.qualities.includes(quality)
                          ? "rgba(34, 197, 94, 0.2)"
                          : "transparent",
                        color: settings.qualities.includes(quality) ? "#22c55e" : "#71717a",
                        cursor: "pointer",
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        transition: "all 0.2s",
                      }}
                      title={QUALITY_INFO[quality]}
                    >
                      {settings.qualities.includes(quality) && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                      {quality}
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: "#71717a" }}>
                  Selected: {settings.qualities.length > 0 ? settings.qualities.join(", ") : "None (will use source resolution)"}
                </div>
              </div>

              {/* Parallel Encodes */}
              <div>
                <label style={{ display: "block", marginBottom: 8, fontSize: 13, color: "#a1a1aa" }}>
                  Parallel Encodes: {settings.parallelEncodes}
                  <span style={{ marginLeft: 8, color: "#71717a", fontSize: 12 }}>
                    (Higher = faster but more CPU usage)
                  </span>
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  {[1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      onClick={() => setSettings(s => ({ ...s, parallelEncodes: n }))}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        border: settings.parallelEncodes === n
                          ? "2px solid #667eea"
                          : "1px solid #3f3f46",
                        background: settings.parallelEncodes === n
                          ? "rgba(102, 126, 234, 0.2)"
                          : "transparent",
                        color: settings.parallelEncodes === n ? "#667eea" : "#a1a1aa",
                        cursor: "pointer",
                        fontSize: 14,
                        fontWeight: 600,
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Reset Button */}
              <button
                onClick={() => setSettings(DEFAULT_SETTINGS)}
                style={{
                  alignSelf: "flex-start",
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "1px solid #3f3f46",
                  background: "transparent",
                  color: "#71717a",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Reset to Defaults
              </button>
            </div>
          )}
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
            width: 64, height: 64, borderRadius: "50%",
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 16px",
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
          <p style={{ color: "#71717a", fontSize: 13 }}>or click to browse</p>
        </div>

        {/* Action Bar */}
        {files.length > 0 && (
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 20, flexWrap: "wrap", gap: 12,
          }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                onClick={handleUploadAll}
                disabled={pendingCount === 0 || isUploading}
                style={{
                  padding: "12px 24px", fontSize: 14, fontWeight: 600,
                  background: pendingCount === 0 || isUploading ? "#3f3f46" : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                  color: pendingCount === 0 || isUploading ? "#71717a" : "white",
                  border: "none", borderRadius: 10,
                  cursor: pendingCount === 0 || isUploading ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                }}
              >
                {isUploading ? (
                  <>
                    <span style={{ animation: "pulse 1.5s infinite" }}>Uploading...</span>
                    <span style={{ background: "rgba(255,255,255,0.2)", padding: "2px 8px", borderRadius: 6, fontSize: 12 }}>
                      {uploadingCount}/{pendingCount + uploadingCount}
                    </span>
                  </>
                ) : (
                  <>
                    Start Upload
                    {pendingCount > 0 && (
                      <span style={{ background: "rgba(255,255,255,0.2)", padding: "2px 8px", borderRadius: 6, fontSize: 12 }}>
                        {pendingCount}
                      </span>
                    )}
                  </>
                )}
              </button>

              {transcodingCount > 0 && (
                <button
                  onClick={cancelAllJobs}
                  style={{
                    padding: "12px 20px", fontSize: 14, fontWeight: 600,
                    background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
                    color: "white", border: "none", borderRadius: 10, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  Stop All
                  <span style={{ background: "rgba(255,255,255,0.2)", padding: "2px 8px", borderRadius: 6, fontSize: 12 }}>
                    {transcodingCount}
                  </span>
                </button>
              )}

              {(completedCount > 0 || errorCount > 0 || cancelledCount > 0) && (
                <button
                  onClick={clearCompleted}
                  style={{
                    padding: "12px 20px", fontSize: 14, fontWeight: 500,
                    background: "transparent", color: "#a1a1aa",
                    border: "1px solid #3f3f46", borderRadius: 10, cursor: "pointer",
                  }}
                >
                  Clear Done
                </button>
              )}
            </div>

            {/* Status Pills */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {pendingCount > 0 && <span style={{ padding: "6px 12px", background: "rgba(113, 113, 122, 0.2)", borderRadius: 20, fontSize: 12, color: "#a1a1aa" }}>{pendingCount} pending</span>}
              {uploadingCount > 0 && <span style={{ padding: "6px 12px", background: "rgba(102, 126, 234, 0.2)", borderRadius: 20, fontSize: 12, color: "#667eea" }}>{uploadingCount} uploading</span>}
              {transcodingCount > 0 && <span style={{ padding: "6px 12px", background: "rgba(245, 158, 11, 0.2)", borderRadius: 20, fontSize: 12, color: "#f59e0b" }}>{transcodingCount} transcoding</span>}
              {completedCount > 0 && <span style={{ padding: "6px 12px", background: "rgba(34, 197, 94, 0.2)", borderRadius: 20, fontSize: 12, color: "#22c55e" }}>{completedCount} complete</span>}
              {cancelledCount > 0 && <span style={{ padding: "6px 12px", background: "rgba(251, 146, 60, 0.2)", borderRadius: 20, fontSize: 12, color: "#fb923c" }}>{cancelledCount} cancelled</span>}
              {errorCount > 0 && <span style={{ padding: "6px 12px", background: "rgba(239, 68, 68, 0.2)", borderRadius: 20, fontSize: 12, color: "#ef4444" }}>{errorCount} failed</span>}
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
                  : fileState.status === "transcoding" ? "rgba(245, 158, 11, 0.3)"
                  : fileState.status === "uploading" ? "rgba(102, 126, 234, 0.3)"
                  : fileState.status === "cancelled" ? "rgba(251, 146, 60, 0.3)"
                  : "rgba(63, 63, 70, 0.5)",
                animation: "slideIn 0.3s ease",
                animationDelay: `${index * 0.05}s`,
                animationFillMode: "backwards",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  background: fileState.status === "completed" ? "rgba(34, 197, 94, 0.15)"
                    : fileState.status === "error" ? "rgba(239, 68, 68, 0.15)"
                    : fileState.status === "transcoding" ? "rgba(245, 158, 11, 0.15)"
                    : fileState.status === "uploading" ? "rgba(102, 126, 234, 0.15)"
                    : fileState.status === "cancelled" ? "rgba(251, 146, 60, 0.15)"
                    : "rgba(113, 113, 122, 0.15)",
                }}>
                  {fileState.status === "completed" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                  ) : fileState.status === "error" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  ) : fileState.status === "cancelled" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2.5"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                  ) : fileState.status === "transcoding" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5" style={{ animation: "spin 2s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                  ) : fileState.status === "uploading" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#667eea" strokeWidth="2.5" style={{ animation: "pulse 1s infinite" }}><polyline points="17 11 12 6 7 11" /><line x1="12" y1="6" x2="12" y2="18" /></svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "#e4e4e7", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fileState.file.name}>
                    {truncateFilename(fileState.file.name)}
                  </div>
                  <div style={{ fontSize: 12, color: "#71717a", display: "flex", gap: 8, alignItems: "center" }}>
                    <span>{formatFileSize(fileState.file.size)}</span>
                    <span style={{ opacity: 0.4 }}>•</span>
                    <span>{Math.ceil(fileState.file.size / CHUNK_SIZE)} chunks</span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  {fileState.status === "transcoding" && fileState.jobId && (
                    <button
                      onClick={() => cancelJob(fileState.id, fileState.jobId!)}
                      style={{
                        padding: "6px 12px", borderRadius: 8,
                        background: "rgba(239, 68, 68, 0.15)",
                        border: "1px solid rgba(239, 68, 68, 0.3)",
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                        color: "#ef4444", fontSize: 12, fontWeight: 500,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                      Stop
                    </button>
                  )}
                  {(fileState.status === "pending" || fileState.status === "completed" || fileState.status === "error" || fileState.status === "cancelled") && (
                    <button
                      onClick={() => removeFile(fileState.id)}
                      style={{
                        width: 32, height: 32, borderRadius: 8,
                        background: "transparent", border: "1px solid #3f3f46",
                        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                        color: "#71717a",
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Progress Bars */}
              {(fileState.status === "uploading" || fileState.status === "uploaded") && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ height: 6, background: "rgba(63, 63, 70, 0.5)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${fileState.progress}%`, borderRadius: 3,
                      background: "linear-gradient(90deg, #667eea 0%, #764ba2 100%)",
                      backgroundSize: "40px 40px",
                      backgroundImage: "linear-gradient(45deg, rgba(255,255,255,0.1) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.1) 75%, transparent 75%, transparent)",
                      animation: "progressStripe 1s linear infinite",
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12 }}>
                    <span style={{ color: "#a1a1aa" }}>{fileState.message}</span>
                    <span style={{ color: "#71717a" }}>{fileState.progress}%</span>
                  </div>
                </div>
              )}

              {fileState.status === "transcoding" && (() => {
                const ws = fileState.jobId ? wsProgress.get(fileState.jobId) : undefined;
                // Use WS percent if available, fall back to BullMQ poll progress
                const percent = ws ? ws.percent : (fileState.transcodeProgress || 0);
                const stageLabel =
                  ws?.stage === "download" ? "Downloading"
                  : ws?.stage === "analyze" ? "Analyzing"
                  : ws?.stage === "encode"  ? `Encoding ${ws.rendition ?? ""}`
                  : ws?.stage === "upload"  ? "Uploading"
                  : ws?.stage === "done"    ? "Done"
                  : null;
                const speedBadge = ws?.speed && ws.speed !== "N/A" && ws.speed !== "0x" ? ws.speed : null;
                const displayMsg = stageLabel
                  ? `${stageLabel}${speedBadge ? ` @ ${speedBadge}` : ""}`
                  : fileState.message;

                return (
                  <div style={{ marginTop: 12 }}>
                    {/* Stage + rendition + speed badges */}
                    {ws && (
                      <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                        <span style={{
                          fontSize: 11, padding: "2px 8px", borderRadius: 4, fontWeight: 600,
                          background: ws.stage === "encode" ? "rgba(245,158,11,0.2)" : "rgba(102,126,234,0.2)",
                          color: ws.stage === "encode" ? "#f59e0b" : "#667eea",
                        }}>
                          {stageLabel}
                        </span>
                        {ws.stage === "encode" && ws.rendition && (
                          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "rgba(113,113,122,0.2)", color: "#a1a1aa" }}>
                            {ws.rendition}
                          </span>
                        )}
                        {speedBadge && (
                          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "rgba(34,197,94,0.1)", color: "#22c55e" }}>
                            {speedBadge}
                          </span>
                        )}
                      </div>
                    )}
                    <div style={{ height: 6, background: "rgba(63, 63, 70, 0.5)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${percent}%`, borderRadius: 3,
                        background: "linear-gradient(90deg, #f59e0b 0%, #d97706 100%)",
                        backgroundSize: "40px 40px",
                        backgroundImage: "linear-gradient(45deg, rgba(255,255,255,0.1) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.1) 75%, transparent 75%, transparent)",
                        animation: "progressStripe 1s linear infinite",
                        transition: "width 0.25s ease",
                      }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12 }}>
                      <span style={{ color: "#f59e0b" }}>{displayMsg}</span>
                      <span style={{ color: "#71717a" }}>{Math.round(percent)}%</span>
                    </div>
                  </div>
                );
              })()}

              {fileState.status === "completed" && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ height: 6, background: "rgba(63, 63, 70, 0.5)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: "100%", borderRadius: 3, background: "#22c55e" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12 }}>
                    <span style={{ color: "#22c55e" }}>{fileState.message}</span>
                    <span style={{ color: "#71717a" }}>100%</span>
                  </div>
                </div>
              )}

              {fileState.status === "error" && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#ef4444", display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                  {fileState.message}
                </div>
              )}

              {fileState.status === "cancelled" && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#fb923c", display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                  {fileState.message}
                </div>
              )}

              {fileState.status === "pending" && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#71717a" }}>Waiting to upload...</div>
              )}
            </div>
          ))}
        </div>

        {/* Empty State */}
        {files.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#52525b" }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: "0 auto 16px", opacity: 0.5 }}>
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <p style={{ fontSize: 15 }}>No videos selected</p>
            <p style={{ fontSize: 13, marginTop: 4, opacity: 0.7 }}>Drag files here or click to browse</p>
          </div>
        )}

        {/* Current Settings Summary */}
        <div style={{
          marginTop: 32, padding: 16, background: "rgba(39, 39, 42, 0.4)",
          borderRadius: 12, fontSize: 13, color: "#71717a",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: "#a1a1aa" }}>Current Settings</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
            <div>Preset: <span style={{ color: "#e4e4e7" }}>{settings.ffmpegPreset}</span></div>
            <div>Quality (CRF): <span style={{ color: "#e4e4e7" }}>{settings.crf}</span></div>
            <div>Resolutions: <span style={{ color: "#e4e4e7" }}>{settings.qualities.join(", ") || "Source"}</span></div>
            <div>Parallel: <span style={{ color: "#e4e4e7" }}>{settings.parallelEncodes}</span></div>
          </div>
        </div>
      </main>
    </>
  );
}
