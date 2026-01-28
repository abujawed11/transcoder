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

    const region = process.env.AWS_REGION || "us-east-1";
    const bucket = process.env.AWS_BUCKET!;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID!;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY!;

    const s3 = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      // Disable automatic checksum - browsers can't compute CRC32
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
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

    console.log("Generated signed URL:", url);
    return NextResponse.json({ url, key, contentType });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to create signed URL" },
      { status: 500 }
    );
  }
}
