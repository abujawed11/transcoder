import { NextResponse } from "next/server";
import { videoQueue } from "@/lib/videoQueue";

export interface TranscodeSettings {
  crf: number;
  ffmpegPreset: string;
  qualities: string[];
  parallelEncodes: number;
}

export async function POST(req: Request) {
  const { key, settings } = await req.json();

  if (!key) {
    return NextResponse.json(
      { error: "object key required" },
      { status: 400 }
    );
  }

  const job = await videoQueue.add("transcode", {
    key,
    settings: settings || {},
  });

  return NextResponse.json({
    status: "queued",
    jobId: job.id,
  });
}
