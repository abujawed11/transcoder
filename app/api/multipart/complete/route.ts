import { NextResponse } from "next/server";
import { S3Client, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";

export async function POST(req: Request) {
  try {
    const { key, uploadId, parts } = await req.json();

    if (!key || !uploadId || !parts || !Array.isArray(parts)) {
      return NextResponse.json(
        { error: "key, uploadId, and parts array are required" },
        { status: 400 }
      );
    }

    const s3 = new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });

    // Sort parts by part number (required by S3)
    const sortedParts = parts.sort((a: any, b: any) => a.PartNumber - b.PartNumber);

    const command = new CompleteMultipartUploadCommand({
      Bucket: process.env.AWS_BUCKET!,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sortedParts,
      },
    });

    await s3.send(command);

    return NextResponse.json({ success: true, key });
  } catch (err: any) {
    console.error("Complete multipart error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to complete upload" },
      { status: 500 }
    );
  }
}
