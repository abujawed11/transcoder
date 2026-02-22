import "dotenv/config";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat } from "node:fs/promises";
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

const s3 = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET;

// Track active ffmpeg processes for cancellation
const activeProcesses = new Map();

// ============================================================================
// DEFAULT QUALITY PRESETS
// ============================================================================
const DEFAULT_QUALITY_PRESETS = [
  { name: "1080p", height: 1080, maxBitrate: "5000k", audioBitrate: "128k" },
  { name: "720p",  height: 720,  maxBitrate: "2500k", audioBitrate: "128k" },
  { name: "480p",  height: 480,  maxBitrate: "1000k", audioBitrate: "96k" },
  { name: "360p",  height: 360,  maxBitrate: "600k",  audioBitrate: "64k" },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function checkCancelled(jobId) {
  const cancelled = await redis.get(`job:${jobId}:cancelled`);
  return cancelled === "true";
}

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

function runFfmpeg(args, jobId, processKey) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);
    const key = `${jobId}-${processKey}`;

    activeProcesses.set(key, ffmpeg);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      activeProcesses.delete(key);

      if (code === 0) {
        resolve({ stdout: "", stderr });
      } else if (code === 255 || code === null) {
        reject(new Error("CANCELLED"));
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    ffmpeg.on("error", (err) => {
      activeProcesses.delete(key);
      reject(err);
    });
  });
}

function killProcessesForJob(jobId) {
  for (const [key, process] of activeProcesses) {
    if (key.startsWith(`${jobId}-`)) {
      console.log(`🛑 Killing ffmpeg process: ${key}`);
      process.kill("SIGKILL");
      activeProcesses.delete(key);
    }
  }
}

/**
 * Build ffmpeg arguments with custom settings
 */
function buildFfmpegArgs(inputPath, outputPath, preset, settings) {
  const { crf, ffmpegPreset } = settings;

  return [
    "-y",
    "-i", inputPath,
    "-vf", `scale=-2:${preset.height}`,
    "-c:v", "h264_nvenc",
    "-preset", "p4",
    "-cq", String(crf),
    "-rc", "vbr",
    "-maxrate", preset.maxBitrate,
    "-bufsize", preset.maxBitrate,
    "-profile:v", "high",
    "-level:v", "4.1",
    "-c:a", "aac",
    "-b:a", preset.audioBitrate,
    "-ac", "2",
    "-movflags", "+faststart",
    outputPath,
  ];
}

function safeNameFromKey(key) {
  return key.replaceAll("/", "_").replaceAll(" ", "_");
}

/**
 * Encode a single quality preset
 */
async function encodeQuality(inputPath, workDir, preset, jobId, settings) {
  const outputPath = path.join(workDir, `${preset.name}.mp4`);

  console.log(`🔄 [${preset.name}] Encoding (preset: ${settings.ffmpegPreset}, CRF: ${settings.crf})...`);

  const ffmpegArgs = buildFfmpegArgs(inputPath, outputPath, preset, settings);
  await runFfmpeg(ffmpegArgs, jobId, preset.name);

  const outputStat = await stat(outputPath);
  const outputSizeMB = (outputStat.size / (1024 * 1024)).toFixed(2);

  console.log(`✅ [${preset.name}] Done (${outputSizeMB} MB)`);

  return {
    name: preset.name,
    localPath: outputPath,
    size: outputStat.size,
  };
}

// ============================================================================
// WORKER
// ============================================================================

const worker = new Worker(
  "video-transcode",
  async (job) => {
    const { key, settings: jobSettings } = job.data;
    const jobId = job.id;

    // Merge default settings with job settings
    const settings = {
      crf: 23,
      ffmpegPreset: "fast",
      qualities: ["1080p", "720p", "480p", "360p"],
      parallelEncodes: 2,
      ...jobSettings,
    };

    console.log(`🎬 Job ${jobId} started: ${key}`);
    console.log(`   Settings: preset=${settings.ffmpegPreset}, CRF=${settings.crf}, qualities=${settings.qualities.join(",")}, parallel=${settings.parallelEncodes}`);

    if (!key) throw new Error("Missing key in job.data");

    if (await checkCancelled(jobId)) {
      console.log(`⏹️ Job ${jobId} was cancelled before starting`);
      throw new Error("Job cancelled");
    }

    const base = safeNameFromKey(key);
    const workDir = path.join(__dirname, "tmp", `${jobId}-${base}`);

    await mkdir(workDir, { recursive: true });

    const inputPath = path.join(workDir, "input.mp4");
    const outputs = {};

    try {
      // 1) Download original from S3
      console.log(`📥 Downloading ${key}...`);
      await downloadObject(key, inputPath);
      console.log(`✅ Downloaded to ${inputPath}`);
      job.updateProgress(10);

      if (await checkCancelled(jobId)) {
        throw new Error("CANCELLED");
      }

      // 2) Probe source video
      console.log(`🔍 Analyzing source video...`);
      const videoInfo = await getVideoInfo(inputPath);
      console.log(`   Source: ${videoInfo.width}x${videoInfo.height}, duration: ${videoInfo.duration.toFixed(1)}s`);

      // 3) Filter presets based on user selection and source resolution
      let applicablePresets = DEFAULT_QUALITY_PRESETS
        .filter(p => settings.qualities.includes(p.name))
        .filter(p => p.height <= videoInfo.height);

      if (applicablePresets.length === 0) {
        // Source is smaller than all selected qualities
        console.log(`⚠️ Source (${videoInfo.height}p) smaller than selected qualities, using original size`);
        applicablePresets.push({
          name: `${videoInfo.height}p`,
          height: videoInfo.height,
          maxBitrate: "500k",
          audioBitrate: "64k",
        });
      }

      console.log(`📋 Generating ${applicablePresets.length} rendition(s): ${applicablePresets.map(p => p.name).join(", ")}`);
      job.updateProgress(15);

      // 4) Transcode with parallel encoding
      const parallelEncodes = Math.min(settings.parallelEncodes, applicablePresets.length);
      console.log(`🚀 Starting encoding (${parallelEncodes} parallel)...`);

      const encodeResults = [];
      const presetQueue = [...applicablePresets];
      const activeEncodes = [];
      let completedCount = 0;

      while (presetQueue.length > 0 || activeEncodes.length > 0) {
        if (await checkCancelled(jobId)) {
          killProcessesForJob(jobId);
          throw new Error("CANCELLED");
        }

        while (presetQueue.length > 0 && activeEncodes.length < parallelEncodes) {
          const preset = presetQueue.shift();
          const encodePromise = encodeQuality(inputPath, workDir, preset, jobId, settings)
            .then(result => {
              completedCount++;
              const progress = 15 + Math.round((completedCount / applicablePresets.length) * 65);
              job.updateProgress(progress);
              return result;
            });

          activeEncodes.push(encodePromise);
        }

        if (activeEncodes.length > 0) {
          const completed = await Promise.race(activeEncodes.map((p, i) => p.then(r => ({ result: r, index: i }))));
          encodeResults.push(completed.result);
          activeEncodes.splice(completed.index, 1);
        }
      }

      // Build outputs map
      for (const result of encodeResults) {
        outputs[result.name] = {
          localPath: result.localPath,
          s3Key: key.replace("uploads/", `outputs/${result.name}/`),
          size: result.size,
        };
      }

      if (await checkCancelled(jobId)) {
        throw new Error("CANCELLED");
      }

      // 5) Upload all outputs to S3
      console.log(`📤 Uploading ${encodeResults.length} transcoded file(s)...`);
      for (const [quality, { localPath, s3Key, size }] of Object.entries(outputs)) {
        if (await checkCancelled(jobId)) {
          throw new Error("CANCELLED");
        }

        await uploadObject(s3Key, localPath, "video/mp4");
        const sizeMB = (size / (1024 * 1024)).toFixed(2);
        console.log(`  ✅ Uploaded ${quality}: ${s3Key} (${sizeMB} MB)`);
      }

      job.updateProgress(100);
      console.log(`🎉 Job ${jobId} completed!`);

      await redis.del(`job:${jobId}:cancelled`);

      return {
        original: key,
        sourceInfo: {
          width: videoInfo.width,
          height: videoInfo.height,
          duration: videoInfo.duration,
        },
        settings,
        outputs: Object.fromEntries(
          Object.entries(outputs).map(([q, { s3Key, size }]) => [q, { key: s3Key, size }])
        ),
      };
    } catch (err) {
      if (err.message === "CANCELLED") {
        console.log(`⏹️ Job ${jobId} was cancelled`);
        await redis.del(`job:${jobId}:cancelled`);
      }
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
  { connection: redis }
);

worker.on("failed", (job, err) => {
  if (err.message === "CANCELLED" || err.message === "Job cancelled" || err.message?.includes("Cancelled")) {
    console.log(`⏹️ Job ${job?.id} cancelled`);
  } else {
    console.error(`❌ Job ${job?.id} failed:`, err.message);
  }
});

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed successfully`);
});

console.log("✅ Worker started (CPU encoding): listening on queue video-transcode");
