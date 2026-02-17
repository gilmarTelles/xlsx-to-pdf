# CLAUDE.md

## Project Overview

Express microservice that converts Excel (.xlsx) files to PDF. It preprocesses spreadsheets with ExcelJS (font sizing, column auto-width, page layout) then delegates the actual PDF rendering to a Gotenberg instance running LibreOffice.

## Architecture

- **index.js** — Single-file Express server. `POST /convert` accepts a multipart file upload, processes it, forwards to Gotenberg, and returns a PDF. `GET /health` for deep health checks (pings Gotenberg).
- **timing-patch.js** — Standalone benchmark script; generates a sample workbook and times the ExcelJS + Gotenberg pipeline.
- **test/convert.test.js** — Jest + Supertest test suite covering validation, auth, conversion, health, and security.

## Prerequisites

- **Node.js** >= 18
- **Docker** (to run Gotenberg)
- **Gotenberg** 8 — LibreOffice-based PDF renderer. Start with:
  ```bash
  docker run --rm -p 3000:3000 gotenberg/gotenberg:8
  ```
- **PM2** (production only) — process manager

## Key Technical Details

- Uses `multer` with memory storage (files stay in RAM, no disk writes).
- All config via environment variables in `.env` (never committed).
- Page setup: fit-to-width, A4 paper (paperSize 9), landscape by default.
- Column widths are auto-calculated from cell content length, clamped between 8 and 50.
- Managed in production with PM2 (process name: `xlsx-to-pdf`).

## Commands

```bash
npm install          # install dependencies
npm start            # start the server
npm test             # run test suite
node timing-patch.js # run the benchmark
```

## Environment Variables

All config lives in `.env`. Never commit `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `GOTENBERG_URL` | `http://localhost:3000/forms/libreoffice/convert` | Gotenberg conversion endpoint |
| `PORT` | `3001` | Express listen port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for all interfaces) |
| `DEFAULT_FONT_SIZE` | `9` | Font size applied to all cells |
| `API_KEY` | *(empty — disabled)* | API key for `X-API-Key` header auth |
| `CORS_ORIGIN` | *(empty — blocked)* | Allowed CORS origin |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | `30` | Max requests per window per IP |
| `MAX_FILE_SIZE` | `52428800` | Max upload size in bytes (50 MB) |
| `CONCURRENCY_LIMIT` | `5` | Max concurrent conversions |
| `GOTENBERG_TIMEOUT_MS` | `60000` | Gotenberg request timeout (ms) |
| `REQUEST_TIMEOUT_MS` | `120000` | Overall request timeout (ms) |
| `LOG_LEVEL` | `info` | Pino log level |

## Dependencies

**Production:**
- **express** v5, **multer** v2 — HTTP + file upload
- **exceljs** — Read/write/modify .xlsx files
- **node-fetch** v2 + **form-data** — Forward files to Gotenberg
- **dotenv** — Load `.env` config
- **helmet** — Security headers
- **cors** — CORS control
- **express-rate-limit** — Rate limiting
- **pino** + **pino-http** — Structured JSON logging
- **p-limit** — Concurrency limiter

**Dev:**
- **jest** — Test runner
- **supertest** — HTTP assertion library
