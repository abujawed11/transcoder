import { NextResponse } from "next/server";
import { videoQueue } from "@/lib/videoQueue";
import { redis } from "@/lib/redis";

export async function POST() {
  try {
    const results = {
      waiting: 0,
      active: 0,
      delayed: 0,
    };

    // Get all active jobs and signal them to cancel via Redis flag
    const activeJobs = await videoQueue.getJobs(["active"]);
    for (const job of activeJobs) {
      if (job.id) {
        // Set cancellation flag - worker will check this and stop
        await redis.set(`job:${job.id}:cancelled`, "true", "EX", 3600);
        results.active++;
      }
    }

    // Remove all waiting jobs
    const waitingJobs = await videoQueue.getJobs(["waiting", "prioritized"]);
    for (const job of waitingJobs) {
      try {
        await job.remove();
        results.waiting++;
      } catch (e) {
        // Job might have been picked up
      }
    }

    // Remove all delayed jobs
    const delayedJobs = await videoQueue.getJobs(["delayed"]);
    for (const job of delayedJobs) {
      try {
        await job.remove();
        results.delayed++;
      } catch (e) {
        // Ignore errors
      }
    }

    const totalCancelled = results.waiting + results.active + results.delayed;

    return NextResponse.json({
      status: "success",
      message: `Cancelled ${totalCancelled} job(s)`,
      details: results,
    });
  } catch (error: any) {
    console.error("Error cancelling all jobs:", error);
    return NextResponse.json(
      { error: error.message || "Failed to cancel jobs" },
      { status: 500 }
    );
  }
}
