import { NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const region = process.env.AWS_REGION || "us-east-1";
    const bucket = process.env.AWS_BUCKET!;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID!;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY!;

    const s3 = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });

    const key = `uploads/${Date.now()}-${file.name}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: file.type || "application/octet-stream",
    });

    await s3.send(cmd);

    console.log(`Uploaded ${key} to MinIO (${buffer.length} bytes)`);

    return NextResponse.json({ key, size: buffer.length });
  } catch (err: any) {
    console.error("Upload error:", err);
    return NextResponse.json(
      { error: err?.message || "Upload failed" },
      { status: 500 }
    );
  }
}

// App Router config for large file uploads
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
