import express from "express";
import mongoose from "mongoose";
import Download from "../models/Download.js";
import { mockDownloads } from "./downloads.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;

  if (isConnected) {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [total, windows, mac, linux, recent] = await Promise.all([
        Download.countDocuments({}),
        Download.countDocuments({ os: "windows" }),
        Download.countDocuments({ os: "mac" }),
        Download.countDocuments({ os: "linux" }),
        Download.countDocuments({ timestamp: { $gte: thirtyDaysAgo } })
      ]);

      return res.status(200).json({
        total,
        windows,
        mac,
        linux,
        recentDays: 30,
        recent
      });
    } catch (err) {
      console.error("[DB Error] Failed to aggregate download stats from database:", err.message);
    }
  }

  // Fallback to in-memory mocks
  const counts = {
    windows: 0,
    mac: 0,
    linux: 0
  };

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let recent = 0;

  mockDownloads.forEach(d => {
    if (counts.hasOwnProperty(d.os)) {
      counts[d.os]++;
    }
    if (new Date(d.timestamp) >= thirtyDaysAgo) {
      recent++;
    }
  });

  const total = mockDownloads.length;

  return res.status(200).json({
    total,
    windows: counts.windows,
    mac: counts.mac,
    linux: counts.linux,
    recentDays: 30,
    recent
  });
});

export default router;
