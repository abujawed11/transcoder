import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Redis } from "ioredis";

const WS_PORT = Number(process.env.WS_PORT || 4001);

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
};

// One subscriber connection (shared across all job channels)
const subClient = new Redis(redisConfig);
// Regular client for GET (latest state) operations
const getClient = new Redis(redisConfig);

// Map: jobId -> Set<WebSocket> — tracks which clients are listening to which job
const subscriptions = new Map();

// Forward Redis pub/sub messages to subscribed WebSocket clients
subClient.on("message", (channel, message) => {
  const jobId = channel.slice("progress:".length);
  const clients = subscriptions.get(jobId);
  if (!clients) return;
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(message);
  }
});

const server = createServer();
const wss = new WebSocketServer({ server, path: "/ws/progress" });

wss.on("connection", (ws) => {
  const subscribedJobIds = new Set();

  ws.on("message", async (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData.toString()); } catch { return; }

    // { type: "subscribe", jobId }  → subscribe to live updates + send latest state
    if (msg.type === "subscribe" && msg.jobId) {
      const jobId = String(msg.jobId);
      if (subscribedJobIds.has(jobId)) return; // already subscribed
      subscribedJobIds.add(jobId);

      if (!subscriptions.has(jobId)) {
        subscriptions.set(jobId, new Set());
        await subClient.subscribe(`progress:${jobId}`);
      }
      subscriptions.get(jobId).add(ws);

      // Send current state immediately so late-joining clients catch up
      const latest = await getClient.get(`progress:${jobId}`);
      if (latest && ws.readyState === 1) ws.send(latest);
    }

    // { type: "getLatest", jobId }  → one-shot fetch of latest state
    else if (msg.type === "getLatest" && msg.jobId) {
      const latest = await getClient.get(`progress:${String(msg.jobId)}`);
      if (latest && ws.readyState === 1) ws.send(latest);
    }
  });

  ws.on("close", () => {
    for (const jobId of subscribedJobIds) {
      const clients = subscriptions.get(jobId);
      if (!clients) continue;
      clients.delete(ws);
      // Unsubscribe from Redis channel when no clients remain
      if (clients.size === 0) {
        subscriptions.delete(jobId);
        subClient.unsubscribe(`progress:${jobId}`);
      }
    }
  });

  ws.on("error", () => { /* close event handles cleanup */ });
});

server.listen(WS_PORT, () => {
  console.log(`✅ Progress WS server listening on ws://localhost:${WS_PORT}/ws/progress`);
});
