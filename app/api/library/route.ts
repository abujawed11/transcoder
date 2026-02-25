import { NextResponse } from "next/server";
import { getLibraryJobs } from "@/lib/getLibrary";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const jobs = await getLibraryJobs();
    return NextResponse.json({ jobs });
  } catch (err: any) {
    console.error("Library error:", err);
    return NextResponse.json({ error: err?.message || "Failed to load library" }, { status: 500 });
  }
}
