# xlsx-to-pdf

A lightweight Express microservice that converts Excel (`.xlsx`) files to PDF. It preprocesses spreadsheets — adjusting font sizes, auto-sizing columns, and configuring page layout — then hands off the PDF rendering to [Gotenberg](https://gotenberg.dev/) (LibreOffice under the hood).

## How It Works

```
Client ──POST /convert──▶ Express (ExcelJS processing) ──▶ Gotenberg (LibreOffice) ──▶ PDF response
```

1. Client uploads an `.xlsx` file to `POST /convert`
2. ExcelJS loads the workbook and applies formatting:
   - Sets font size on every cell (default 9pt)
   - Auto-calculates column widths from content length
   - Configures page setup (landscape, fit-to-width, A4)
3. The modified spreadsheet is forwarded to Gotenberg for PDF conversion
4. The generated PDF is returned to the client

## Prerequisites

- **Node.js** >= 18
- **Gotenberg** with LibreOffice module — easiest via Docker:

```bash
docker run --rm -p 3000:3000 gotenberg/gotenberg:8
```

## Setup

```bash
git clone https://github.com/gilmarTelles/xlsx-to-pdf.git
cd xlsx-to-pdf
npm install
cp .env.example .env   # edit .env if needed
node index.js
```

The server starts on port `3001` by default.

## Configuration

All configuration is done through environment variables. Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Description |
|---|---|---|
| `GOTENBERG_URL` | `http://localhost:3000/forms/libreoffice/convert` | Gotenberg conversion endpoint |
| `PORT` | `3001` | Port the server listens on |
| `DEFAULT_FONT_SIZE` | `9` | Font size applied to all cells before conversion |

## API

### `POST /convert`

Converts an uploaded Excel file to PDF.

**Request** — `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | Yes | The `.xlsx` file to convert |
| `fontSize` | string | No | Font size in points (default: `9`) |
| `landscape` | string | No | `"true"` or `"false"` (default: `"true"`) |
| `singlePageSheets` | string | No | `"true"` or `"false"` (default: `"true"`) |

**Response** — `application/pdf`

Returns the converted PDF file as a download (`export.pdf`).

**Example with curl:**

```bash
curl -X POST http://localhost:3001/convert \
  -F "file=@spreadsheet.xlsx" \
  -F "fontSize=10" \
  -F "landscape=true" \
  -o output.pdf
```

### `GET /health`

Returns `{ "status": "ok" }` — useful for load balancer health checks.

## Production

The service is designed to run behind PM2:

```bash
pm2 start index.js --name xlsx-to-pdf
pm2 save
```

## Benchmarking

A built-in timing script generates a sample 100-row spreadsheet and measures the pipeline:

```bash
node timing-patch.js
```
