import { NextResponse } from "next/server";
import { videoQueue } from "@/lib/videoQueue";

export async function POST(req: Request) {
  const { key } = await req.json();

  if (!key) {
    return NextResponse.json(
      { error: "object key required" },
      { status: 400 }
    );
  }

  await videoQueue.add("transcode", {
    key,
  });

  return NextResponse.json({ status: "queued" });
}
