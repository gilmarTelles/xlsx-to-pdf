const request = require("supertest");
const ExcelJS = require("exceljs");
const http = require("http");

// Mock node-fetch before requiring the app
let mockFetchResponse;
let mockFetchError;
jest.mock("node-fetch", () => {
  return jest.fn(async (url, opts) => {
    if (mockFetchError) throw mockFetchError;
    if (!mockFetchResponse) {
      throw new Error("No mock configured");
    }
    return mockFetchResponse;
  });
});

// Disable pino logging in tests
jest.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    error: noop,
    warn: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
  };
  const pinoFn = () => logger;
  pinoFn.destination = () => ({});
  return pinoFn;
});

jest.mock("pino-http", () => {
  return () => (req, res, next) => {
    req.log = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    };
    next();
  };
});

const { app, config } = require("../index");

// Helper: create a real XLSX buffer using ExcelJS
async function createXlsxBuffer() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Hello", "World"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Helper: fake PDF buffer
const FAKE_PDF = Buffer.from("%PDF-1.4 fake pdf content");

beforeEach(() => {
  mockFetchResponse = null;
  mockFetchError = null;
  config.apiKey = "";
});

// ---- Validation tests ----

describe("POST /convert - validation", () => {
  test("returns 400 when no file uploaded", async () => {
    const res = await request(app).post("/convert");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  test("returns 400 for non-xlsx file (invalid magic bytes)", async () => {
    const textBuf = Buffer.from("this is not an xlsx file");
    const res = await request(app)
      .post("/convert")
      .attach("file", textBuf, "bad.xlsx");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid file type/i);
  });

  test("returns 400 for empty/tiny file with invalid magic bytes", async () => {
    const res = await request(app)
      .post("/convert")
      .attach("file", Buffer.alloc(10), "tiny.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid file type/i);
  });
});

// ---- Auth tests ----

describe("API key authentication", () => {
  test("returns 401 when API key is configured but missing", async () => {
    config.apiKey = "test-secret-key";
    const res = await request(app).post("/convert");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  test("returns 401 when API key is wrong", async () => {
    config.apiKey = "test-secret-key";
    const res = await request(app)
      .post("/convert")
      .set("X-API-Key", "wrong-key");
    expect(res.status).toBe(401);
  });

  test("passes when API key matches", async () => {
    config.apiKey = "test-secret-key";
    // Should get past auth and hit validation (400 no file)
    const res = await request(app)
      .post("/convert")
      .set("X-API-Key", "test-secret-key");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  test("skips auth when API_KEY is not set", async () => {
    config.apiKey = "";
    const res = await request(app).post("/convert");
    expect(res.status).toBe(400); // no file, but not 401
  });
});

// ---- Conversion tests (Gotenberg mocked) ----

describe("POST /convert - conversion", () => {
  test("returns PDF with correct headers on success", async () => {
    mockFetchResponse = {
      ok: true,
      status: 200,
      buffer: async () => FAKE_PDF,
    };

    const xlsxBuf = await createXlsxBuffer();
    const res = await request(app)
      .post("/convert")
      .attach("file", xlsxBuf, "test.xlsx");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(/test\.pdf/);
    expect(res.body).toEqual(FAKE_PDF);
  });

  test("returns 502 when Gotenberg errors", async () => {
    mockFetchResponse = {
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    };

    const xlsxBuf = await createXlsxBuffer();
    const res = await request(app)
      .post("/convert")
      .attach("file", xlsxBuf, "test.xlsx");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/conversion failed/i);
  });

  test("returns 504 when Gotenberg times out", async () => {
    mockFetchError = new Error("Timeout");
    mockFetchError.name = "AbortError";

    const xlsxBuf = await createXlsxBuffer();
    const res = await request(app)
      .post("/convert")
      .attach("file", xlsxBuf, "test.xlsx");

    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });
});

// ---- Health check tests ----

describe("GET /health", () => {
  test("returns ok when Gotenberg is reachable", async () => {
    mockFetchResponse = {
      ok: true,
      status: 200,
    };

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.gotenberg).toBe("reachable");
    expect(res.body.uptime).toBeGreaterThan(0);
  });

  test("returns degraded when Gotenberg is down", async () => {
    mockFetchError = new Error("Connection refused");

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.gotenberg).toBe("unreachable");
  });
});

// ---- Security tests ----

describe("Security headers", () => {
  test("helmet headers present in response", async () => {
    const res = await request(app).get("/health").catch(() => ({}));
    // Helmet sets various security headers
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

describe("Rate limiter", () => {
  test("includes rate limit headers in responses", async () => {
    mockFetchResponse = { ok: true, status: 200 };
    const res = await request(app).get("/health");
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });
});

// ---- Filename & fontSize tests ----

describe("POST /convert - options", () => {
  test("uses original filename in Content-Disposition", async () => {
    mockFetchResponse = {
      ok: true,
      status: 200,
      buffer: async () => FAKE_PDF,
    };

    const xlsxBuf = await createXlsxBuffer();
    const res = await request(app)
      .post("/convert")
      .attach("file", xlsxBuf, "report.xlsx");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/report\.pdf/);
  });

  test("clamps fontSize to valid range", async () => {
    mockFetchResponse = {
      ok: true,
      status: 200,
      buffer: async () => FAKE_PDF,
    };

    const xlsxBuf = await createXlsxBuffer();
    // fontSize=200 should be clamped, not cause an error
    const res = await request(app)
      .post("/convert")
      .field("fontSize", "200")
      .attach("file", xlsxBuf, "test.xlsx");

    expect(res.status).toBe(200);
  });
});

// ---- Filename sanitization ----

describe("POST /convert - filename sanitization", () => {
  test("strips dangerous characters from filename", async () => {
    mockFetchResponse = {
      ok: true,
      status: 200,
      buffer: async () => FAKE_PDF,
    };

    const xlsxBuf = await createXlsxBuffer();
    const res = await request(app)
      .post("/convert")
      .attach("file", xlsxBuf, 'evil"; rm -rf /.xlsx');

    expect(res.status).toBe(200);
    const disposition = res.headers["content-disposition"];
    // Should be sanitized — no quotes, semicolons, or spaces inside the filename
    expect(disposition).toMatch(/filename="[a-zA-Z0-9._-]+"/);
    expect(disposition).not.toMatch(/rm/);
  });

  test("handles filenames with spaces and special chars", async () => {
    mockFetchResponse = {
      ok: true,
      status: 200,
      buffer: async () => FAKE_PDF,
    };

    const xlsxBuf = await createXlsxBuffer();
    const res = await request(app)
      .post("/convert")
      .attach("file", xlsxBuf, "my report (2024).xlsx");

    expect(res.status).toBe(200);
    const disposition = res.headers["content-disposition"];
    // Should be sanitized — no parens or spaces
    expect(disposition).toMatch(/filename="[a-zA-Z0-9._-]+"/);
  });
});

// ---- Memory pressure ----

describe("POST /convert - memory limit", () => {
  test("returns 503 when memory limit is exceeded", async () => {
    // Set limit to 1 MB — any Node process exceeds this
    const original = config.memoryLimitMB;
    config.memoryLimitMB = 1;

    const xlsxBuf = await createXlsxBuffer();
    const res = await request(app)
      .post("/convert")
      .attach("file", xlsxBuf, "test.xlsx");

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/heavy load/i);

    config.memoryLimitMB = original;
  });

  test("health endpoint reports memory usage", async () => {
    mockFetchResponse = { ok: true, status: 200 };
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.memoryMB).toBeDefined();
    expect(typeof res.body.memoryMB).toBe("number");
  });
});

// ---- 404 catch-all ----

describe("404 catch-all", () => {
  test("returns JSON 404 for undefined routes", async () => {
    const res = await request(app).get("/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
