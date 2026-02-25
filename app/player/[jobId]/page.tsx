"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface JobDetails {
  id: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  outputs: Record<string, { key: string; size: number }>;
  thumbnailKey: string | null;
  createdAt: number;
}

const QUALITY_ORDER = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p"];

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export default function PlayerPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;

  const [job, setJob] = useState<JobDetails | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingTime = useRef<number | null>(null);

  const fetchStreamUrl = useCallback(async (key: string): Promise<string> => {
    const res = await fetch(`/api/stream?key=${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error("Failed to get stream URL");
    const data = await res.json();
    return data.url;
  }, []);

  // Mount: load job details and select default quality
  useEffect(() => {
    if (!jobId) return;

    (async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/details`);
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Job not found");
        }
        const data: JobDetails = await res.json();
        setJob(data);

        // Pick highest available quality
        const available = QUALITY_ORDER.filter((q) => data.outputs[q]);
        const defaultQuality = available[0] || Object.keys(data.outputs)[0] || "";
        setSelectedQuality(defaultQuality);

        if (defaultQuality && data.outputs[defaultQuality]) {
          const url = await fetchStreamUrl(data.outputs[defaultQuality].key);
          setVideoUrl(url);
        }
      } catch (e: any) {
        setError(e.message || "Failed to load video");
      } finally {
        setLoading(false);
      }
    })();
  }, [jobId, fetchStreamUrl]);

  // Quality switch handler
  const handleQualitySwitch = useCallback(async (quality: string) => {
    if (!job || quality === selectedQuality) return;

    const currentTime = videoRef.current?.currentTime ?? 0;
    pendingTime.current = currentTime;
    setSelectedQuality(quality);

    try {
      const url = await fetchStreamUrl(job.outputs[quality].key);
      setVideoUrl(url);
    } catch (e: any) {
      console.error("Failed to switch quality:", e);
    }
  }, [job, selectedQuality, fetchStreamUrl]);

  // Restore time after quality switch
  const handleLoadedMetadata = useCallback(() => {
    if (pendingTime.current !== null && videoRef.current) {
      videoRef.current.currentTime = pendingTime.current;
      pendingTime.current = null;
      videoRef.current.play().catch(() => {});
    }
  }, []);

  const availableQualities = job
    ? QUALITY_ORDER.filter((q) => job.outputs[q])
    : [];

  const selectedOutput = job?.outputs[selectedQuality];

  return (
    <main style={{ padding: "24px", minHeight: "calc(100vh - 56px)", background: "#0f0f1a" }}>
      <Link href="/library" style={{
        color: "#a1a1aa", textDecoration: "none", fontSize: 14,
        display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 20,
      }}>
        ← Back to Library
      </Link>

      {loading && (
        <p style={{ color: "#71717a" }}>Loading…</p>
      )}

      {error && (
        <p style={{ color: "#f87171" }}>{error}</p>
      )}

      {job && !error && (
        <div style={{ maxWidth: 960 }}>
          <h1 style={{ color: "#f4f4f5", fontSize: 20, fontWeight: 700, marginTop: 0, marginBottom: 16 }}>
            {job.title}
          </h1>

          {/* Video player */}
          {videoUrl ? (
            <video
              ref={videoRef}
              controls
              src={videoUrl}
              onLoadedMetadata={handleLoadedMetadata}
              style={{
                width: "100%",
                maxWidth: 960,
                aspectRatio: "16/9",
                background: "#000",
                borderRadius: 8,
                display: "block",
              }}
            />
          ) : (
            <div style={{
              width: "100%", maxWidth: 960, aspectRatio: "16/9",
              background: "#09090b", borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#71717a", fontSize: 14,
            }}>
              Loading video…
            </div>
          )}

          {/* Quality switcher */}
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            {availableQualities.map((q) => (
              <button
                key={q}
                onClick={() => handleQualitySwitch(q)}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  background: q === selectedQuality ? "#667eea" : "#27272a",
                  color: q === selectedQuality ? "#fff" : "#a1a1aa",
                  transition: "background 0.15s",
                }}
              >
                {q}
              </button>
            ))}
          </div>

          {/* Metadata */}
          <p style={{ color: "#71717a", fontSize: 13, marginTop: 12 }}>
            {job.title}
            {job.width > 0 && ` • ${job.width}×${job.height}`}
            {job.duration > 0 && ` • ${formatDuration(job.duration)}`}
            {selectedOutput && ` • ${formatSize(selectedOutput.size)}`}
          </p>
        </div>
      )}
    </main>
  );
}
