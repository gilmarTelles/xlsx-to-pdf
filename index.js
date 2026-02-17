require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const FormData = require("form-data");
const fetch = require("node-fetch");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const pino = require("pino");
const pinoHttp = require("pino-http");
const pLimit = require("p-limit");

// --- Configuration ---
const config = {
  port: parseInt(process.env.PORT) || 3001,
  host: process.env.HOST || "127.0.0.1",
  gotenbergUrl: process.env.GOTENBERG_URL || "http://localhost:3000/forms/libreoffice/convert",
  defaultFontSize: parseInt(process.env.DEFAULT_FONT_SIZE) || 9,
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024,
  concurrencyLimit: parseInt(process.env.CONCURRENCY_LIMIT) || 5,
  gotenbergTimeoutMs: parseInt(process.env.GOTENBERG_TIMEOUT_MS) || 60000,
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS) || 120000,
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX) || 30,
  apiKey: process.env.API_KEY || "",
  corsOrigin: process.env.CORS_ORIGIN || false,
  memoryLimitMB: parseInt(process.env.MEMORY_LIMIT_MB) || 512,
};

// --- Logger ---
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

// --- App setup ---
const app = express();

// Trust proxy for rate limiter behind reverse proxy
app.set("trust proxy", 1);

// Middleware stack
app.use(helmet());
app.use(cors({ origin: config.corsOrigin || false }));
app.use(pinoHttp({ logger, quietReqLogger: true }));

// Rate limiter
app.use(
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  })
);

// API key middleware (opt-in: only enforced when API_KEY is set)
app.use((req, res, next) => {
  if (!config.apiKey) return next();
  const provided = req.headers["x-api-key"] || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(config.apiKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Request timeout middleware
app.use((req, res, next) => {
  req.setTimeout(config.requestTimeoutMs);
  res.setTimeout(config.requestTimeoutMs, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: "Request timeout" });
    }
  });
  next();
});

// --- Multer with file size limit ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSize },
});

// --- Concurrency limiter ---
const limit = pLimit(config.concurrencyLimit);

// --- XLSX magic bytes: PK\x03\x04 (ZIP format) ---
const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function isValidXlsx(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return buffer.subarray(0, 4).equals(XLSX_MAGIC);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// --- Memory tracking ---
function getMemoryUsageMB() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

// --- Routes ---

app.post("/convert", upload.single("file"), async (req, res) => {
  try {
    const currentMemory = getMemoryUsageMB();
    if (currentMemory > config.memoryLimitMB) {
      req.log.warn({ memoryMB: currentMemory, limitMB: config.memoryLimitMB }, "Memory limit exceeded, rejecting request");
      return res.status(503).json({ error: "Server is under heavy load, please try again later" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (!isValidXlsx(req.file.buffer)) {
      return res.status(400).json({ error: "Invalid file type. Only .xlsx files are accepted" });
    }

    const rawFontSize = parseInt(req.body.fontSize) || config.defaultFontSize;
    const fontSize = Math.min(Math.max(rawFontSize, 6), 72);
    const landscape = req.body.landscape || "true";
    const singlePageSheets = req.body.singlePageSheets || "true";

    req.log.info({ fileSize: req.file.size }, "File received, starting conversion");

    const pdfBuffer = await limit(async () => {
      const startExcel = Date.now();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);

      workbook.eachSheet((worksheet) => {
        worksheet.columns.forEach((column) => {
          let maxLength = 0;
          column.eachCell({ includeEmpty: false }, (cell) => {
            cell.font = { ...cell.font, size: fontSize };
            const cellValue = cell.value ? cell.value.toString() : "";
            maxLength = Math.max(maxLength, cellValue.length);
          });
          column.width = Math.min(Math.max(maxLength + 2, 8), 50);
        });
        worksheet.pageSetup = {
          ...worksheet.pageSetup,
          orientation: landscape === "true" ? "landscape" : "portrait",
          fitToPage: true,
          fitToWidth: 1,
          fitToHeight: 0,
          paperSize: 9,
        };
      });

      const modifiedBuffer = await workbook.xlsx.writeBuffer();
      req.log.info({ excelMs: Date.now() - startExcel }, "ExcelJS processing complete");

      // Send to Gotenberg with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.gotenbergTimeoutMs);

      try {
        const form = new FormData();
        form.append("files", Buffer.from(modifiedBuffer), {
          filename: "export.xlsx",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        form.append("landscape", landscape);
        form.append("singlePageSheets", singlePageSheets);

        const startGotenberg = Date.now();
        const gotenbergRes = await fetch(config.gotenbergUrl, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });

        if (!gotenbergRes.ok) {
          const errText = await gotenbergRes.text();
          req.log.error({ status: gotenbergRes.status, error: errText }, "Gotenberg error");
          const statusCode = gotenbergRes.status >= 500 ? 502 : gotenbergRes.status;
          return { error: true, statusCode, message: "PDF conversion failed" };
        }

        const pdf = await gotenbergRes.buffer();
        req.log.info({ gotenbergMs: Date.now() - startGotenberg, pdfSize: pdf.length }, "Gotenberg conversion complete");
        return { error: false, data: pdf };
      } finally {
        clearTimeout(timeout);
      }
    });

    if (pdfBuffer.error) {
      return res.status(pdfBuffer.statusCode).json({ error: pdfBuffer.message });
    }

    const originalName = req.file.originalname || "export.xlsx";
    const pdfName = sanitizeFilename(originalName.replace(/\.xlsx$/i, ".pdf"));
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfName}"`,
      "Content-Length": pdfBuffer.data.length,
    });
    res.send(pdfBuffer.data);
  } catch (err) {
    if (err.name === "AbortError") {
      req.log.error("Gotenberg request timed out");
      return res.status(504).json({ error: "PDF conversion timed out" });
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large" });
    }
    req.log.error({ err }, "Conversion error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/health", async (req, res) => {
  const memoryMB = getMemoryUsageMB();
  const health = { status: "ok", uptime: process.uptime(), memoryMB };

  try {
    // Derive Gotenberg health URL from conversion URL
    const gotenbergBase = config.gotenbergUrl.replace(/\/forms\/.*$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(`${gotenbergBase}/health`, { signal: controller.signal });
      if (resp.ok) {
        health.gotenberg = "reachable";
      } else {
        health.status = "degraded";
        health.gotenberg = "unhealthy";
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    health.status = "degraded";
    health.gotenberg = "unreachable";
  }

  const statusCode = health.status === "ok" ? 200 : 503;
  res.status(statusCode).json(health);
});

// --- 404 catch-all ---
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Server & graceful shutdown ---
let server;

function startServer() {
  server = app.listen(config.port, config.host, () => {
    logger.info({ port: config.port, host: config.host }, "XLSX-to-PDF service started");
  });
  return server;
}

function gracefulShutdown(signal) {
  logger.info({ signal }, "Received shutdown signal, closing server");
  if (server) {
    server.close(() => {
      logger.info("Server closed, exiting");
      process.exit(0);
    });
    // Force exit after 10s if connections don't close
    setTimeout(() => {
      logger.warn("Forced exit after timeout");
      process.exit(1);
    }, 10000).unref();
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start server only when run directly (not when required for tests)
if (require.main === module) {
  startServer();
}

module.exports = { app, config, startServer, logger };
