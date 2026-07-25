import express from "express";
import mongoose from "mongoose";
import Download from "../models/Download.js";

const router = express.Router();

// Mock store fallback if MongoDB is not connected
export const mockDownloads = [
  { os: "windows", version: "v1.0.0", timestamp: new Date(Date.now() - 3600000 * 2), country: "US" },
  { os: "mac", version: "v1.0.0", timestamp: new Date(Date.now() - 3600000 * 24 * 5), country: "CA" },
  { os: "linux", version: "v1.0.0", timestamp: new Date(Date.now() - 3600000 * 24 * 10), country: "DE" },
  { os: "windows", version: "v1.0.0", timestamp: new Date(Date.now() - 3600000 * 24 * 15), country: "PK" },
  { os: "mac", version: "v1.0.0", timestamp: new Date(Date.now() - 3600000 * 24 * 40), country: "GB" }
];

router.post("/:os", async (req, res) => {
  const { os } = req.params;
  const version = req.body.version || "v1.0.0";

  if (!os || !["windows", "mac", "linux"].includes(os)) {
    return res.status(400).json({ error: "Invalid OS. Must be 'windows', 'mac', or 'linux'" });
  }

  // Derive country from Vercel headers if available, else default to Unknown
  const country = req.headers["x-vercel-ip-country"] || "Unknown";

  const isConnected = mongoose.connection.readyState === 1;

  if (isConnected) {
    try {
      const newDownload = new Download({
        os,
        version,
        country
      });
      await newDownload.save();
      console.log(`[DB] Logged download event: OS=${os}, Version=${version}, Country=${country}`);
      return res.status(201).json({ success: true, os, version });
    } catch (err) {
      console.error("[DB Error] Could not save download record:", err.message);
    }
  }

  // Local memory fallback
  const mockEntry = {
    os,
    version,
    timestamp: new Date(),
    country
  };
  mockDownloads.unshift(mockEntry);
  console.log(`[Backup] Logged download event in-memory: OS=${os}, Version=${version}, Country=${country}`);
  return res.status(201).json({ success: true, os, version });
});

export default router;
