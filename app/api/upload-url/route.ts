import { NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export async function POST(req: Request) {
  try {
    const { filename, contentType } = await req.json();

    if (!filename || !contentType) {
      return NextResponse.json(
        { error: "filename and contentType are required" },
        { status: 400 }
      );
    }

    const endpoint = process.env.MINIO_ENDPOINT!;
    const region = process.env.MINIO_REGION || "us-east-1";
    const bucket = process.env.MINIO_BUCKET!;
    const accessKeyId = process.env.MINIO_ACCESS_KEY!;
    const secretAccessKey = process.env.MINIO_SECRET_KEY!;

    const s3 = new S3Client({
      region,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true, // IMPORTANT for MinIO
    });

    // Store uploads under a prefix
    const key = `uploads/${Date.now()}-${filename}`;

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });

    // Signed URL valid for 5 minutes
    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 });

    return NextResponse.json({ url, key });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to create signed URL" },
      { status: 500 }
    );
  }
}
