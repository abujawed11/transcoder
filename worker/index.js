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
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

// Support both MinIO (local) and S3 (cloud)
const s3 = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT, // Required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET;

// ============================================================================
// QUALITY PRESETS - Only renditions <= source resolution will be generated
// ============================================================================
// CRF (Constant Rate Factor): Lower = better quality, larger file
// - CRF 18-20: Visually lossless for most content
// - CRF 23: Default, good balance
// - CRF 28: Lower quality, smaller files
//
// maxBitrate: Safety cap to prevent bloated files (especially for high-motion content)
// ============================================================================
const QUALITY_PRESETS = [
  { name: "1080p", height: 1080, crf: 23, maxBitrate: "5000k", audioBitrate: "128k" },
  { name: "720p",  height: 720,  crf: 23, maxBitrate: "2500k", audioBitrate: "128k" },
  { name: "480p",  height: 480,  crf: 24, maxBitrate: "1000k", audioBitrate: "96k" },
  { name: "360p",  height: 360,  crf: 26, maxBitrate: "600k",  audioBitrate: "64k" },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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
  const { createReadStream } = await import("node:fs");
  const fileStream = createReadStream(filePath);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
    },
    partSize: 5 * 1024 * 1024,
    queueSize: 4,
  });

  await upload.done();
}

/**
 * Get video metadata using ffprobe
 * Returns: { width, height, duration, bitrate }
 */
async function getVideoInfo(inputPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,bit_rate,duration",
    "-show_entries", "format=duration,bit_rate",
    "-of", "json",
    inputPath,
  ]);

  const data = JSON.parse(stdout);
  const stream = data.streams?.[0] || {};
  const format = data.format || {};

  return {
    width: stream.width || 0,
    height: stream.height || 0,
    duration: parseFloat(stream.duration || format.duration || 0),
    bitrate: parseInt(stream.bit_rate || format.bit_rate || 0, 10),
  };
}

/**
 * Filter quality presets to only include renditions <= source height
 * This prevents upscaling which wastes resources and inflates file size
 */
function getApplicablePresets(sourceHeight) {
  return QUALITY_PRESETS.filter((preset) => preset.height <= sourceHeight);
}

/**
 * Run ffmpeg with the given arguments
 */
function runFfmpeg(args) {
  return execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 50 });
}

/**
 * Build ffmpeg arguments for CRF-based encoding with bitrate cap
 *
 * Why this approach:
 * - CRF gives consistent quality regardless of content complexity
 * - maxrate + bufsize prevent file size explosion on high-motion scenes
 * - No upscaling = no wasted bits on fake detail
 */
function buildFfmpegArgs(inputPath, outputPath, preset) {
  return [
    "-y",                              // Overwrite output
    "-i", inputPath,                   // Input file

    // Video scaling (height-based, maintain aspect ratio)
    "-vf", `scale=-2:${preset.height}`,

    // Video codec: H.264 with CRF quality control
    "-c:v", "libx264",
    "-preset", "medium",               // Better compression than veryfast
    "-crf", String(preset.crf),        // Quality target
    "-maxrate", preset.maxBitrate,     // Bitrate ceiling (prevents bloat)
    "-bufsize", preset.maxBitrate,     // VBV buffer size = maxrate (1 second buffer)

    // Encoding profile for compatibility
    "-profile:v", "high",
    "-level:v", "4.1",

    // Audio: AAC with reasonable bitrate
    "-c:a", "aac",
    "-b:a", preset.audioBitrate,
    "-ac", "2",                        // Stereo

    // Output container optimization
    "-movflags", "+faststart",         // Enable streaming playback

    outputPath,
  ];
}

function safeNameFromKey(key) {
  return key.replaceAll("/", "_").replaceAll(" ", "_");
}

// ============================================================================
// WORKER
// ============================================================================

new Worker(
  "video-transcode",
  async (job) => {
    const { key } = job.data;
    console.log(`🎬 Job ${job.id} started: ${key}`);
    if (!key) throw new Error("Missing key in job.data");

    const base = safeNameFromKey(key);
    const workDir = path.join(__dirname, "tmp", `${job.id}-${base}`);

    await mkdir(workDir, { recursive: true });

    const inputPath = path.join(workDir, "input.mp4");
    const outputs = {};

    try {
      // 1) Download original from S3
      console.log(`📥 Downloading ${key}...`);
      await downloadObject(key, inputPath);
      console.log(`✅ Downloaded to ${inputPath}`);
      job.updateProgress(10);

      // 2) Probe source video to get resolution
      console.log(`🔍 Analyzing source video...`);
      const videoInfo = await getVideoInfo(inputPath);
      console.log(`   Source: ${videoInfo.width}x${videoInfo.height}, ` +
                  `duration: ${videoInfo.duration.toFixed(1)}s, ` +
                  `bitrate: ${Math.round(videoInfo.bitrate / 1000)}kbps`);

      // 3) Filter presets to avoid upscaling
      const applicablePresets = getApplicablePresets(videoInfo.height);

      if (applicablePresets.length === 0) {
        // Source is smaller than our smallest preset (360p)
        // Just copy/re-encode at original size
        console.log(`⚠️ Source (${videoInfo.height}p) is smaller than minimum preset (360p)`);
        console.log(`   Will generate only a re-encoded copy at original resolution`);
        applicablePresets.push({
          name: `${videoInfo.height}p`,
          height: videoInfo.height,
          crf: 24,
          maxBitrate: "500k",
          audioBitrate: "64k",
        });
      }

      console.log(`📋 Will generate ${applicablePresets.length} rendition(s): ` +
                  `${applicablePresets.map(p => p.name).join(", ")}`);

      // Log skipped renditions
      const skippedPresets = QUALITY_PRESETS.filter(p => p.height > videoInfo.height);
      if (skippedPresets.length > 0) {
        console.log(`⏭️ Skipping ${skippedPresets.length} rendition(s) (would upscale): ` +
                    `${skippedPresets.map(p => p.name).join(", ")}`);
      }

      job.updateProgress(15);

      // 4) Transcode to applicable quality levels only
      const totalQualities = applicablePresets.length;
      for (let i = 0; i < totalQualities; i++) {
        const preset = applicablePresets[i];
        const outputPath = path.join(workDir, `${preset.name}.mp4`);

        console.log(`🔄 Transcoding to ${preset.name} (CRF ${preset.crf}, max ${preset.maxBitrate})...`);

        const ffmpegArgs = buildFfmpegArgs(inputPath, outputPath, preset);
        await runFfmpeg(ffmpegArgs);

        // Get output file size for logging
        const { stat } = await import("node:fs/promises");
        const outputStat = await stat(outputPath);
        const outputSizeMB = (outputStat.size / (1024 * 1024)).toFixed(2);

        console.log(`✅ ${preset.name} done (${outputSizeMB} MB)`);

        outputs[preset.name] = {
          localPath: outputPath,
          s3Key: key.replace("uploads/", `outputs/${preset.name}/`),
          size: outputStat.size,
        };

        // Update progress (15% analysis + 65% transcoding distributed across qualities)
        const progress = 15 + Math.round(((i + 1) / totalQualities) * 65);
        job.updateProgress(progress);
      }

      // 5) Upload all outputs to S3
      console.log(`📤 Uploading ${totalQualities} transcoded file(s)...`);
      for (const [quality, { localPath, s3Key, size }] of Object.entries(outputs)) {
        await uploadObject(s3Key, localPath, "video/mp4");
        const sizeMB = (size / (1024 * 1024)).toFixed(2);
        console.log(`  ✅ Uploaded ${quality}: ${s3Key} (${sizeMB} MB)`);
      }

      job.updateProgress(100);
      console.log(`🎉 Job ${job.id} completed!`);

      return {
        original: key,
        sourceInfo: {
          width: videoInfo.width,
          height: videoInfo.height,
          duration: videoInfo.duration,
        },
        outputs: Object.fromEntries(
          Object.entries(outputs).map(([q, { s3Key, size }]) => [q, { key: s3Key, size }])
        ),
      };
    } finally {
      // Cleanup temp files
      await rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redis }
);

console.log("✅ Worker started: listening on queue video-transcode");
