import { NextResponse } from "next/server";
import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Support both MinIO (local) and S3 (cloud)
function getS3Client() {
  const endpoint = process.env.S3_ENDPOINT;

  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: endpoint || undefined,
    forcePathStyle: !!endpoint,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });
}

export async function POST(req: Request) {
  try {
    const { key, uploadId, partNumbers } = await req.json();

    if (!key || !uploadId || !partNumbers || !Array.isArray(partNumbers)) {
      return NextResponse.json(
        { error: "key, uploadId, and partNumbers array are required" },
        { status: 400 }
      );
    }

    const s3 = getS3Client();

    // Generate presigned URLs for all requested parts
    const presignedUrls: { [partNumber: number]: string } = {};

    await Promise.all(
      partNumbers.map(async (partNumber: number) => {
        const command = new UploadPartCommand({
          Bucket: process.env.S3_BUCKET!,
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
