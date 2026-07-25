import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Routers
import downloadsRouter from "./api/downloads.js";
import statsRouter from "./api/stats.js";

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001; // Listen on port 3001 for local development

// Middleware
// Enable CORS for frontend origin (development on localhost:3000, or vercel subdomains)
app.use(cors({
  origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
  credentials: true
}));
app.use(express.json());

// Resilient MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.warn("⚠️ MONGODB_URI is not defined in environment variables. Running in local memory-fallback mode.");
} else {
  console.log("🔌 Connecting to MongoDB Atlas...");
  mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ Successfully connected to MongoDB Atlas."))
    .catch((err) => {
      console.error("❌ MongoDB connection failed. Running in memory-fallback mode.", err.message);
    });
}

// API Routes
app.use("/api/download", downloadsRouter); // Mount downloads under /api/download/:os
app.use("/api/stats", statsRouter);       // Mount stats under /api/stats

// Default API landing
app.get("/api", (req, res) => {
  res.json({
    message: "UnitGen MERN Tracking API is online.",
    status: "healthy",
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "fallback_mode"
  });
});

// Run local listener if executed directly
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`🚀 UnitGen API listening at http://localhost:${PORT}`);
  });
}

export default app;
