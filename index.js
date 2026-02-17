require("dotenv").config();

const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const FormData = require("form-data");
const fetch = require("node-fetch");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const GOTENBERG_URL = process.env.GOTENBERG_URL || "http://localhost:3000/forms/libreoffice/convert";
const DEFAULT_FONT_SIZE = parseInt(process.env.DEFAULT_FONT_SIZE) || 9;

app.post("/convert", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fontSize = parseInt(req.body.fontSize) || DEFAULT_FONT_SIZE;
    const landscape = req.body.landscape || "true";
    const singlePageSheets = req.body.singlePageSheets || "true";

    console.log(`File received: ${req.file.size} bytes`);
    console.time("1-ExcelJS-load");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    console.timeEnd("1-ExcelJS-load");

    console.time("2-ExcelJS-process");
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
    console.timeEnd("2-ExcelJS-process");

    console.time("3-ExcelJS-write");
    const modifiedBuffer = await workbook.xlsx.writeBuffer();
    console.timeEnd("3-ExcelJS-write");

    console.time("4-Gotenberg");
    const form = new FormData();
    form.append("files", Buffer.from(modifiedBuffer), {
      filename: "export.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    form.append("landscape", landscape);
    form.append("singlePageSheets", singlePageSheets);

    const gotenbergRes = await fetch(GOTENBERG_URL, {
      method: "POST",
      body: form,
    });

    if (!gotenbergRes.ok) {
      const errText = await gotenbergRes.text();
      return res.status(gotenbergRes.status).json({ error: errText });
    }

    const pdfBuffer = await gotenbergRes.buffer();
    console.timeEnd("4-Gotenberg");

    console.log(`PDF generated: ${pdfBuffer.length} bytes`);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="export.pdf"',
      "Content-Length": pdfBuffer.length,
    });

    res.send(pdfBuffer);
  } catch (err) {
    console.error("Conversion error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("XLSX-to-PDF service running on port " + PORT);
});
