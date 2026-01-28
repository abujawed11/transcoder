import { NextResponse } from "next/server";
import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export async function POST(req: Request) {
  try {
    const { key, uploadId, partNumbers } = await req.json();

    if (!key || !uploadId || !partNumbers || !Array.isArray(partNumbers)) {
      return NextResponse.json(
        { error: "key, uploadId, and partNumbers array are required" },
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

    // Generate presigned URLs for all requested parts
    const presignedUrls: { [partNumber: number]: string } = {};

    await Promise.all(
      partNumbers.map(async (partNumber: number) => {
        const command = new UploadPartCommand({
          Bucket: process.env.AWS_BUCKET!,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        });

        const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour
        presignedUrls[partNumber] = url;
      })
    );

    return NextResponse.json({ presignedUrls });
  } catch (err: any) {
    console.error("Presign parts error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to generate presigned URLs" },
      { status: 500 }
    );
  }
}
