import Link from "next/link";
import { getLibraryJobs, LibraryJob } from "@/lib/getLibrary";
import VideoCard from "./VideoCard";

export default async function LibraryPage() {
  let jobs: LibraryJob[] = [];
  let error: string | null = null;

  try {
    jobs = await getLibraryJobs();
  } catch (e: any) {
    error = e?.message || "Failed to load library";
  }

  return (
    <main style={{ padding: "32px 24px", minHeight: "calc(100vh - 56px)", background: "#0f0f1a" }}>
      <h1 style={{ color: "#f4f4f5", fontSize: 24, fontWeight: 700, marginBottom: 24, marginTop: 0 }}>
        Library
      </h1>

      {error && (
        <p style={{ color: "#f87171" }}>{error}</p>
      )}

      {!error && jobs.length === 0 && (
        <div style={{ textAlign: "center", padding: "80px 0", color: "#71717a" }}>
          <p style={{ fontSize: 18, marginBottom: 8 }}>No transcoded videos yet</p>
          <p style={{ fontSize: 14 }}>
            <Link href="/" style={{ color: "#667eea" }}>Upload a video</Link> to get started
          </p>
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 24,
      }}>
        {jobs.map((job) => (
          <VideoCard key={job.id} job={job} />
        ))}
      </div>
    </main>
  );
}
