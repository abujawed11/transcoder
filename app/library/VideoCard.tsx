"use client";

import Link from "next/link";
import { LibraryJob } from "@/lib/getLibrary";

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

export default function VideoCard({ job }: { job: LibraryJob }) {
  return (
    <Link href={`/player/${job.id}`} style={{ textDecoration: "none", color: "inherit" }}>
      <div
        style={{
          background: "#18181b",
          borderRadius: 10,
          overflow: "hidden",
          border: "1px solid #27272a",
          cursor: "pointer",
          transition: "border-color 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#667eea")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#27272a")}
      >
        {/* Thumbnail */}
        <div style={{ position: "relative", aspectRatio: "16/9", background: "#09090b" }}>
          {job.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={job.thumbnailUrl}
              alt={job.title}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          ) : (
            <div style={{
              width: "100%", height: "100%",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#3f3f46", fontSize: 40,
            }}>
              ▶
            </div>
          )}
          {job.duration > 0 && (
            <span style={{
              position: "absolute", bottom: 6, right: 8,
              background: "rgba(0,0,0,0.75)", color: "#fff",
              fontSize: 12, padding: "2px 6px", borderRadius: 4,
            }}>
              {formatDuration(job.duration)}
            </span>
          )}
        </div>

        {/* Info */}
        <div style={{ padding: "12px 14px" }}>
          <p style={{
            margin: "0 0 8px", color: "#f4f4f5", fontWeight: 600, fontSize: 14,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {job.title}
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            {job.qualities.map((q) => (
              <span key={q} style={{
                background: "#27272a", color: "#a1a1aa",
                fontSize: 11, padding: "2px 7px", borderRadius: 4, fontWeight: 500,
              }}>
                {q}
              </span>
            ))}
          </div>
          <p style={{ margin: 0, color: "#71717a", fontSize: 12 }}>
            {formatSize(job.totalSize)}
          </p>
        </div>
      </div>
    </Link>
  );
}
