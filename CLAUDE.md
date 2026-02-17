# CLAUDE.md

## Project Overview

Express microservice that converts Excel (.xlsx) files to PDF. It preprocesses spreadsheets with ExcelJS (font sizing, column auto-width, page layout) then delegates the actual PDF rendering to a Gotenberg instance running LibreOffice.

## Architecture

- **index.js** — Single-file Express server. `POST /convert` accepts a multipart file upload, processes it, forwards to Gotenberg, and returns a PDF. `GET /health` for liveness checks.
- **timing-patch.js** — Standalone benchmark script; generates a sample workbook and times the ExcelJS + Gotenberg pipeline.

## Key Technical Details

- Uses `multer` with memory storage (files stay in RAM, no disk writes).
- Gotenberg URL and port are configured via environment variables (see `.env.example`).
- Page setup: fit-to-width, A4 paper (paperSize 9), landscape by default.
- Column widths are auto-calculated from cell content length, clamped between 8 and 50.
- Managed in production with PM2 (process name: `xlsx-to-pdf`).

## Commands

```bash
npm install          # install dependencies
node index.js        # start the server
node timing-patch.js # run the benchmark
```

## Environment Variables

All config lives in `.env` (see `.env.example`). Never commit `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `GOTENBERG_URL` | `http://localhost:3000/forms/libreoffice/convert` | Gotenberg conversion endpoint |
| `PORT` | `3001` | Express listen port |
| `DEFAULT_FONT_SIZE` | `9` | Font size applied to all cells |

## Dependencies

- **express** v5, **multer** v2 — HTTP + file upload
- **exceljs** — Read/write/modify .xlsx files
- **node-fetch** v2 + **form-data** — Forward files to Gotenberg
- **dotenv** — Load `.env` config

## External Dependency

Requires a running [Gotenberg](https://gotenberg.dev/) instance with the LibreOffice module enabled. Typically run via Docker:

```bash
docker run --rm -p 3000:3000 gotenberg/gotenberg:8
```
