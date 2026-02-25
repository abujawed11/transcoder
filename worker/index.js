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

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
};

// BullMQ connection
const redis = new Redis(redisConfig);

// Separate pub/sub publisher (ioredis requires a dedicated connection for pub/sub)
const pubClient = new Redis(redisConfig);

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

// Throttle map: jobId -> last publish timestamp (ms)
const publishThrottle = new Map();

// ============================================================================
// PROGRESS PUB/SUB
// ============================================================================

/**
 * Publish a progress payload to Redis channel `progress:<jobId>`.
 * Also persists the latest payload as a Redis key (TTL 1h) for late-joining clients.
 * Throttled to max 4 updates/second unless force=true.
 *
 * Payload shape:
 *   { jobId, stage, rendition?, percent, speed?, fps?, message?, ts }
 * Stages: "download" | "analyze" | "encode" | "upload" | "done" | "error"
 */
async function publishProgress(jobId, payload, force = false) {
  const now = Date.now();
  if (!force && now - (publishThrottle.get(jobId) || 0) < 250) return;
  publishThrottle.set(jobId, now);

  const channel = `progress:${jobId}`;
  const msg = JSON.stringify({ ...payload, ts: now });
  await pubClient.publish(channel, msg);
  await pubClient.set(channel, msg, "EX", 3600);
}

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

/**
 * Spawn ffmpeg and parse structured progress from stdout (-progress pipe:1).
 * Calls onProgress(frame) for each complete progress block, where frame contains
 * fields like out_time_us, fps, speed, bitrate, etc.
 */
function runFfmpeg(args, jobId, processKey, onProgress) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);
    const key = `${jobId}-${processKey}`;

    activeProcesses.set(key, ffmpeg);

    let stderr = "";
    let stdoutBuf = "";
    let currentFrame = {};

    // Parse -progress pipe:1 output: key=value lines, each block ends with "progress=continue|end"
    ffmpeg.stdout.on("data", (data) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const k = line.slice(0, eqIdx).trim();
        const v = line.slice(eqIdx + 1).trim();
        currentFrame[k] = v;
        if (k === "progress") {
          if (onProgress) onProgress({ ...currentFrame });
          currentFrame = {};
        }
      }
    });

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
 * Build ffmpeg arguments.
 * Uses -progress pipe:1 -nostats for structured real-time progress on stdout.
 * Encoder: h264_nvenc (GPU). Overall progress mapped per-rendition via out_time_us.
 */
function buildFfmpegArgs(inputPath, outputPath, preset, settings) {
  const { crf } = settings;

  const encoder = process.env.FFMPEG_ENCODER || "libx264";
  const useGpu = encoder === "h264_nvenc";

  return [
    "-y",
    "-progress", "pipe:1",
    "-nostats",
    "-i", inputPath,
    "-vf", `scale=-2:${preset.height}`,
    "-c:v", encoder,
    ...(useGpu
      ? ["-preset", "p4", "-rc", "vbr", "-cq", String(crf), "-b:v", "0"]
      : ["-preset", "fast", "-crf", String(crf)]
    ),
    "-maxrate", preset.maxBitrate,
    "-bufsize", preset.maxBitrate,
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
 * Encode a single quality preset and report per-frame progress.
 *
 * @param {number} duration - source video duration in seconds
 * @param {(renditionName: string, percent: number, speed: string, fps: number) => void} onRenditionProgress
 */
async function encodeQuality(inputPath, workDir, preset, jobId, settings, duration, onRenditionProgress) {
  const outputPath = path.join(workDir, `${preset.name}.mp4`);

  console.log(`🔄 [${preset.name}] Encoding (CRF: ${settings.crf})...`);

  const ffmpegArgs = buildFfmpegArgs(inputPath, outputPath, preset, settings);

  await runFfmpeg(ffmpegArgs, jobId, preset.name, (frame) => {
    // out_time_us is microseconds elapsed in output stream
    const outTimeUs = parseInt(frame.out_time_us || frame.out_time_ms || "0", 10);
    const percent = duration > 0
      ? Math.min(100, (outTimeUs / (duration * 1e6)) * 100)
      : 0;
    const speed = frame.speed || "?";
    const fps = parseFloat(frame.fps || "0");
    if (onRenditionProgress) onRenditionProgress(preset.name, percent, speed, fps);
  });

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
    console.log(`   Settings: CRF=${settings.crf}, qualities=${settings.qualities.join(",")}, parallel=${settings.parallelEncodes}`);

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

    // Per-rendition encode progress: renditionName -> percent (0-100)
    // Overall encode percent = average across all renditions, mapped to job range 15-80%.
    const renditionProgress = new Map();

    function getOverallEncodePercent() {
      if (renditionProgress.size === 0) return 0;
      const vals = [...renditionProgress.values()];
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }

    try {
      // ── Stage: download ──────────────────────────────────────────────────
      await publishProgress(jobId, { jobId, stage: "download", percent: 0, message: `Downloading ${key}` }, true);
      console.log(`📥 Downloading ${key}...`);
      await downloadObject(key, inputPath);
      console.log(`✅ Downloaded to ${inputPath}`);
      job.updateProgress(10);
      await publishProgress(jobId, { jobId, stage: "download", percent: 10, message: "Download complete" }, true);

      if (await checkCancelled(jobId)) throw new Error("CANCELLED");

      // ── Stage: analyze ───────────────────────────────────────────────────
      await publishProgress(jobId, { jobId, stage: "analyze", percent: 10, message: "Analyzing video" }, true);
      console.log(`🔍 Analyzing source video...`);
      const videoInfo = await getVideoInfo(inputPath);
      console.log(`   Source: ${videoInfo.width}x${videoInfo.height}, duration: ${videoInfo.duration.toFixed(1)}s`);
      await publishProgress(jobId, {
        jobId, stage: "analyze", percent: 15,
        message: `${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s`,
      }, true);

      // Filter presets based on user selection and source resolution
      let applicablePresets = DEFAULT_QUALITY_PRESETS
        .filter(p => settings.qualities.includes(p.name))
        .filter(p => p.height <= videoInfo.height);

      if (applicablePresets.length === 0) {
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

      // Initialize rendition progress to 0
      for (const p of applicablePresets) renditionProgress.set(p.name, 0);

      // ── Stage: encode ────────────────────────────────────────────────────
      const parallelEncodes = Math.min(settings.parallelEncodes, applicablePresets.length);
      console.log(`🚀 Starting encoding (${parallelEncodes} parallel)...`);

      await publishProgress(jobId, {
        jobId, stage: "encode", percent: 15,
        message: `Encoding ${applicablePresets.map(p => p.name).join(", ")} (${parallelEncodes} parallel)`,
      }, true);

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

          const encodePromise = encodeQuality(
            inputPath, workDir, preset, jobId, settings,
            videoInfo.duration,
            // Per-frame progress callback (throttled internally by publishProgress)
            (renditionName, pct, speed, fps) => {
              renditionProgress.set(renditionName, pct);
              // Overall job percent: encode stage occupies 15-80%
              const totalPercent = Math.round(15 + (getOverallEncodePercent() / 100) * 65);
              publishProgress(jobId, {
                jobId,
                stage: "encode",
                rendition: renditionName,
                percent: totalPercent,
                speed,
                fps,
                message: `Encoding ${renditionName} @ ${speed}`,
              }).catch(() => {});
            }
          ).then(result => {
            completedCount++;
            renditionProgress.set(result.name, 100);
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

      if (await checkCancelled(jobId)) throw new Error("CANCELLED");

      // ── Stage: upload ────────────────────────────────────────────────────
      const outputEntries = Object.entries(outputs);
      console.log(`📤 Uploading ${encodeResults.length} transcoded file(s)...`);
      await publishProgress(jobId, { jobId, stage: "upload", percent: 80, message: `Uploading ${encodeResults.length} file(s)` }, true);

      for (let i = 0; i < outputEntries.length; i++) {
        const [quality, { localPath, s3Key, size }] = outputEntries[i];
        if (await checkCancelled(jobId)) throw new Error("CANCELLED");

        const uploadPct = Math.round(80 + ((i + 1) / outputEntries.length) * 15);
        await publishProgress(jobId, { jobId, stage: "upload", percent: uploadPct, message: `Uploading ${quality}` }, true);

        await uploadObject(s3Key, localPath, "video/mp4");
        const sizeMB = (size / (1024 * 1024)).toFixed(2);
        console.log(`  ✅ Uploaded ${quality}: ${s3Key} (${sizeMB} MB)`);
      }

      job.updateProgress(100);
      console.log(`🎉 Job ${jobId} completed!`);

      // ── Stage: thumbnail ─────────────────────────────────────────────────
      let thumbnailKey = null;
      try {
        const thumbPath = path.join(workDir, "thumb.jpg");
        const thumbTime = (videoInfo.duration * 0.05).toFixed(2);
        await execFileAsync("ffmpeg", [
          "-y", "-ss", thumbTime, "-i", inputPath,
          "-vframes", "1", "-vf", "scale=640:-1", "-q:v", "3", thumbPath,
        ]);
        thumbnailKey = `thumbnails/${jobId}.jpg`;
        await uploadObject(thumbnailKey, thumbPath, "image/jpeg");
        console.log(`🖼️ Thumbnail uploaded: ${thumbnailKey}`);
      } catch (e) {
        console.warn(`⚠️ Thumbnail generation failed for job ${jobId}:`, e.message);
      }

      // ── Stage: done ──────────────────────────────────────────────────────
      await publishProgress(jobId, { jobId, stage: "done", percent: 100, message: "Transcoding complete" }, true);
      await redis.del(`job:${jobId}:cancelled`);
      publishThrottle.delete(jobId);

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
        thumbnailKey,
      };
    } catch (err) {
      if (err.message === "CANCELLED") {
        console.log(`⏹️ Job ${jobId} was cancelled`);
        await publishProgress(jobId, { jobId, stage: "error", percent: 0, message: "Cancelled" }, true);
        await redis.del(`job:${jobId}:cancelled`);
      } else {
        await publishProgress(jobId, { jobId, stage: "error", percent: 0, message: err.message }, true);
      }
      publishThrottle.delete(jobId);
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

const encoder = process.env.FFMPEG_ENCODER || "libx264";
console.log(`✅ Worker started (encoder: ${encoder} + live progress): listening on queue video-transcode`);
