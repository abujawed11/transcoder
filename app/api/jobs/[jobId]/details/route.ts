import { NextResponse } from "next/server";
import { videoQueue } from "@/lib/videoQueue";

function cleanTitle(original: string): string {
  let name = original.replace(/^uploads\//, "");
  name = name.replace(/^\d{10,13}[-_]/, "");
  name = name.replace(/\.[^.]+$/, "");
  name = name.replace(/[_-]+/g, " ").trim();
  return name || original;
}

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  try {
    const job = await videoQueue.getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const state = await job.getState();
    if (state !== "completed") {
      return NextResponse.json({ error: "Job not completed" }, { status: 404 });
    }

    const rv = job.returnvalue as any;
    const outputs: Record<string, { key: string; size: number }> = rv?.outputs || {};
    const sourceInfo = rv?.sourceInfo || {};

    return NextResponse.json({
      id: job.id,
      title: cleanTitle(rv?.original || ""),
      duration: sourceInfo.duration || 0,
      width: sourceInfo.width || 0,
      height: sourceInfo.height || 0,
      outputs,
      thumbnailKey: rv?.thumbnailKey || null,
      createdAt: job.timestamp || 0,
    });
  } catch (err: any) {
    console.error("Job details error:", err);
    return NextResponse.json({ error: err?.message || "Failed to get job details" }, { status: 500 });
  }
}
