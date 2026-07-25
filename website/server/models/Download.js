import mongoose from "mongoose";

const downloadSchema = new mongoose.Schema({
  os: {
    type: String,
    required: true,
    enum: ["windows", "mac", "linux"]
  },
  version: {
    type: String,
    default: "v1.0.0"
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  country: {
    type: String,
    default: "Unknown"
  }
});

// Avoid Mongoose Model compilation error if already defined (for serverless/hot reload)
export default mongoose.models.Download || mongoose.model("Download", downloadSchema);
