import { NextResponse } from "next/server";
import { S3Client, CreateMultipartUploadCommand } from "@aws-sdk/client-s3";

// Support both MinIO (local) and S3 (cloud)
function getS3Client() {
  const endpoint = process.env.S3_ENDPOINT; // e.g., http://localhost:9000 for MinIO

  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: endpoint || undefined,
    forcePathStyle: !!endpoint, // Required for MinIO
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });
}

export async function POST(req: Request) {
  try {
    const { filename, contentType } = await req.json();

    console.log("Initiate upload:", { filename, contentType });
    console.log("S3 config:", {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      bucket: process.env.S3_BUCKET,
      hasAccessKey: !!process.env.S3_ACCESS_KEY,
    });

    if (!filename || !contentType) {
      return NextResponse.json(
        { error: "filename and contentType are required" },
        { status: 400 }
      );
    }

    const s3 = getS3Client();

    const key = `uploads/${Date.now()}-${filename}`;

    const command = new CreateMultipartUploadCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: key,
      ContentType: contentType,
    });

    const response = await s3.send(command);

    return NextResponse.json({
      uploadId: response.UploadId,
      key,
    });
  } catch (err: any) {
    console.error("Initiate multipart error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to initiate upload" },
      { status: 500 }
    );
  }
}
