import { NextResponse } from "next/server";
import { videoQueue } from "@/lib/videoQueue";
import { redis } from "@/lib/redis";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  if (!jobId) {
    return NextResponse.json(
      { error: "jobId is required" },
      { status: 400 }
    );
  }

  try {
    const job = await videoQueue.getJob(jobId);

    if (!job) {
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404 }
      );
    }

    const state = await job.getState();

    // If job is active, set cancellation flag - worker will check this and stop
    if (state === "active") {
      // Set a cancellation flag in Redis that the worker will check
      await redis.set(`job:${jobId}:cancelled`, "true", "EX", 3600);

      // Don't try to moveToFailed here - the worker holds the lock
      // The worker will detect the flag and fail itself

      return NextResponse.json({
        status: "cancelling",
        message: "Cancellation signal sent. Job will stop shortly.",
        jobId,
      });
    }

    // If job is waiting or delayed, just remove it
    if (state === "waiting" || state === "delayed" || state === "prioritized") {
      await job.remove();
      return NextResponse.json({
        status: "cancelled",
        message: "Job removed from queue",
        jobId,
      });
    }

    // Job is already completed or failed
    return NextResponse.json({
      status: "already_finished",
      message: `Job is already ${state}`,
      jobId,
      state,
    });
  } catch (error: any) {
    console.error("Error cancelling job:", error);
    return NextResponse.json(
      { error: error.message || "Failed to cancel job" },
      { status: 500 }
    );
  }
}
