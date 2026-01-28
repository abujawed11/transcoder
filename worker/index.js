import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT || 6379),
});

const s3 = new S3Client({
  region: process.env.MINIO_REGION || "us-east-1",
  endpoint: process.env.MINIO_ENDPOINT || "http://minio:9000",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretAccessKey: process.env.MINIO_SECRET_KEY || "minioadmin123",
  },
  forcePathStyle: true,
});

const BUCKET = process.env.MINIO_BUCKET || "video-app";

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadObject(key, outPath) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const buf = await streamToBuffer(res.Body);
  await import("node:fs/promises").then((m) => m.writeFile(outPath, buf));
}

async function uploadObject(key, filePath, contentType) {
  const { readFile } = await import("node:fs/promises");
  const Body = await readFile(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body,
      ContentType: contentType,
    })
  );
}

function runFfmpeg(args) {
  // ffmpeg is available in the Docker image we'll build
  return execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 20 });
}

function safeNameFromKey(key) {
  return key.replaceAll("/", "_").replaceAll(" ", "_");
}

new Worker(
  "video-transcode",
  async (job) => {
    const { key } = job.data;
    if (!key) throw new Error("Missing key in job.data");

    const base = safeNameFromKey(key);
    const workDir = path.join(__dirname, "tmp", `${job.id}-${base}`);

    await mkdir(workDir, { recursive: true });

    const inputPath = path.join(workDir, "input.mp4");
    const out720 = path.join(workDir, "720p.mp4");
    const out480 = path.join(workDir, "480p.mp4");

    try {
      job.updateProgress(5);

      // 1) Download original from MinIO
      await downloadObject(key, inputPath);
      job.updateProgress(25);

      // 2) Transcode 720p
      await runFfmpeg([
        "-y",
        "-i",
        inputPath,
        "-vf",
        "scale=-2:720",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        out720,
      ]);
      job.updateProgress(55);

      // 3) Transcode 480p
      await runFfmpeg([
        "-y",
        "-i",
        inputPath,
        "-vf",
        "scale=-2:480",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        out480,
      ]);
      job.updateProgress(80);

      // 4) Upload outputs back to MinIO
      const outKey720 = key.replace("uploads/", "outputs/720p/");
      const outKey480 = key.replace("uploads/", "outputs/480p/");

      await uploadObject(outKey720, out720, "video/mp4");
      await uploadObject(outKey480, out480, "video/mp4");

      job.updateProgress(100);

      return {
        original: key,
        out720: outKey720,
        out480: outKey480,
      };
    } finally {
      // cleanup
      await rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redis }
);

console.log("✅ Worker started: listening on queue video-transcode");
