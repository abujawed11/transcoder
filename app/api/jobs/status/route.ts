import { NextResponse } from "next/server";
import { videoQueue } from "@/lib/videoQueue";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobIds = searchParams.get("ids")?.split(",").filter(Boolean) || [];

  if (jobIds.length === 0) {
    return NextResponse.json(
      { error: "No job IDs provided" },
      { status: 400 }
    );
  }

  try {
    const statuses: Record<string, { state: string; progress: number; failedReason?: string }> = {};

    for (const jobId of jobIds) {
      const job = await videoQueue.getJob(jobId);
      if (job) {
        const state = await job.getState();
        statuses[jobId] = {
          state,
          progress: job.progress as number || 0,
          failedReason: state === "failed" ? job.failedReason : undefined,
        };
      } else {
        statuses[jobId] = { state: "not_found", progress: 0 };
      }
    }

    return NextResponse.json({ statuses });
  } catch (error: any) {
    console.error("Error getting job statuses:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get job statuses" },
      { status: 500 }
    );
  }
}
