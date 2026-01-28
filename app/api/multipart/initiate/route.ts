import { NextResponse } from "next/server";
import { S3Client, CreateMultipartUploadCommand } from "@aws-sdk/client-s3";

export async function POST(req: Request) {
  try {
    const { filename, contentType } = await req.json();

    if (!filename || !contentType) {
      return NextResponse.json(
        { error: "filename and contentType are required" },
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

    const key = `uploads/${Date.now()}-${filename}`;

    const command = new CreateMultipartUploadCommand({
      Bucket: process.env.AWS_BUCKET!,
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
