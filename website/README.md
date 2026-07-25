# UnitGen Landing Page & Download Tracker

A MERN stack website tracking platform downloads and compiled metrics for **UnitGen**—an automated unit test generation and self-healing engine. Both React frontend and Express server are hosted under a unified serverless environment on Vercel.

---

## Folder Structure

```
/website
  /client                  ← React frontend (Vite)
    /src
      /components          ← reusable components
      /pages               ← one file per page
      /assets              ← images, icons
      App.jsx
      main.jsx
    index.html
    vite.config.js
    package.json

  /server                  ← Express backend
    /api
      downloads.js         ← download tracking routes
      stats.js             ← analytics routes
    /models
      Download.js          ← Mongoose model
    server.js              ← Express entry point
    package.json

  vercel.json              ← Vercel config (routes frontend + API together)
  .env.example             ← template for environment variables
  README.md
```

---

## Local Development Setup

To run both client and server concurrently:

### 1. Install Dependencies

Install packages in both folders:

```bash
# Install backend dependencies
cd server && npm install

# Install frontend dependencies
cd ../client && npm install
```

### 2. Configure Environment Variables

Create a `.env` file at the `/website/server` directory (or `/website` root) based on `.env.example`:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/unitgen
GITHUB_RELEASES_BASE_URL=https://github.com/<username>/UnitGen/releases/download
```

### 3. Run Development Servers

Run the backend Express API first, then launch the React dev server:

```bash
# Start backend API (runs on port 3001)
cd server && npm run dev

# Start frontend (runs on port 3000, proxies requests to port 3001)
cd ../client && npm run dev
```

---

## Unified Deployment with Vercel

The website uses a unified deployment structure (`vercel.json`). Vercel automatically compiles your client assets via static builds, and converts `server/server.js` into serverless route controllers.

### Routing Wireframes:
- All `/api/*` endpoints are automatically routed to our serverless Express entrypoint: `server/server.js`.
- All other endpoints (landing, documentation, routing routes) serve static compiled React assets inside `client/dist`.
