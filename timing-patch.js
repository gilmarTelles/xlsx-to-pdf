// Quick timing test
require("dotenv").config();

const FormData = require("form-data");
const fetch = require("node-fetch");
const ExcelJS = require("exceljs");
const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const GOTENBERG_URL = process.env.GOTENBERG_URL || "http://localhost:3000/forms/libreoffice/convert";

async function test() {
  // Create a sample xlsx with some data
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (let i = 0; i < 100; i++) {
    ws.addRow(["Company " + i, "Account " + i, "Currency USD", 12345.67, 98765.43, 54321.00]);
  }
  const buf = await wb.xlsx.writeBuffer();

  const startExcel = Date.now();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf);
  workbook.eachSheet((worksheet) => {
    worksheet.columns.forEach((column) => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = { ...cell.font, size: 9 };
        const cellValue = cell.value ? cell.value.toString() : "";
        maxLength = Math.max(maxLength, cellValue.length);
      });
      column.width = Math.min(Math.max(maxLength + 2, 8), 50);
    });
  });
  const modified = await workbook.xlsx.writeBuffer();
  logger.info({ ms: Date.now() - startExcel }, "ExcelJS processing");

  const startGotenberg = Date.now();
  const form = new FormData();
  form.append("files", Buffer.from(modified), {
    filename: "export.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  form.append("landscape", "true");
  const res = await fetch(GOTENBERG_URL, { method: "POST", body: form });
  await res.buffer();
  logger.info({ ms: Date.now() - startGotenberg }, "Gotenberg conversion");
}

test().catch((err) => {
  logger.error({ err }, "Timing test failed");
  process.exit(1);
});
