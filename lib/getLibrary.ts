import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { videoQueue } from "./videoQueue";

export interface LibraryJob {
  id: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  qualities: string[];
  totalSize: number;
  outputs: Record<string, { key: string; size: number }>;
  thumbnailUrl: string | null;
  thumbnailKey: string | null;
  createdAt: number;
}

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

function cleanTitle(original: string): string {
  // Strip "uploads/" prefix
  let name = original.replace(/^uploads\//, "");
  // Strip timestamp prefix like "1234567890-" or "1234567890_"
  name = name.replace(/^\d{10,13}[-_]/, "");
  // Strip extension
  name = name.replace(/\.[^.]+$/, "");
  // Replace underscores/dashes with spaces
  name = name.replace(/[_-]+/g, " ").trim();
  return name || original;
}

export async function getLibraryJobs(): Promise<LibraryJob[]> {
  const s3 = getS3Client();
  const completed = await videoQueue.getCompleted(0, 99);

  const jobs: LibraryJob[] = await Promise.all(
    completed.map(async (job) => {
      const rv = job.returnvalue as any;
      const outputs: Record<string, { key: string; size: number }> = rv?.outputs || {};
      const sourceInfo = rv?.sourceInfo || {};
      const thumbnailKey: string | null = rv?.thumbnailKey || null;

      let thumbnailUrl: string | null = null;
      if (thumbnailKey) {
        try {
          thumbnailUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: thumbnailKey }),
            { expiresIn: 3600 }
          );
        } catch {
          // ignore
        }
      }

      const qualities = Object.keys(outputs);
      const totalSize = qualities.reduce((sum, q) => sum + (outputs[q]?.size || 0), 0);

      return {
        id: job.id!,
        title: cleanTitle(rv?.original || ""),
        duration: sourceInfo.duration || 0,
        width: sourceInfo.width || 0,
        height: sourceInfo.height || 0,
        qualities,
        totalSize,
        outputs,
        thumbnailUrl,
        thumbnailKey,
        createdAt: job.timestamp || 0,
      };
    })
  );

  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}
