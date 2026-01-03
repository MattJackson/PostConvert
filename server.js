import express from "express";
import sharp from "sharp";
import { execFile } from "child_process";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import archiver from "archiver";

const app = express();

app.use(express.raw({ type: "*/*", limit: "30mb" }));

app.get("/", (_req, res) => res.status(200).send("postconvert: ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

function requireAuth(req, res) {
  const token = process.env.CONVERTER_TOKEN;
  const auth = req.headers.authorization || "";
  if (!token || auth !== `Bearer ${token}`) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

function isPdfRequest(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const filename = String(req.headers["x-filename"] || "").toLowerCase();
  return contentType === "application/pdf" || filename.endsWith(".pdf");
}

// ---------- Core converters ----------

async function toJpegWithSharp(inputBuffer) {
  return sharp(inputBuffer, {
    failOnError: false,
    // Safety: avoid decompression bombs
    limitInputPixels: 200e6,
  })
    .rotate()
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function toJpegWithFfmpeg(inputBuffer) {
  const id = randomUUID();
  const inPath = `/tmp/${id}.bin`; // ffmpeg probes container; extension not required
  const outPath = `/tmp/${id}.jpg`;

  await fs.writeFile(inPath, inputBuffer);

  await execFilePromise("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    inPath,
    "-frames:v",
    "1",
    "-q:v",
    "1", // high quality JPEG
    outPath,
  ]);

  const jpg = await fs.readFile(outPath);

  // Normalize via sharp so output settings are consistent (quality 100, 4:4:4)
  return toJpegWithSharp(jpg);
}

async function toJpegWithMagick(inputBuffer) {
  const id = randomUUID();
  const inPath = `/tmp/${id}.bin`;
  const outPath = `/tmp/${id}.jpg`;

  await fs.writeFile(inPath, inputBuffer);

  // ImageMagick: convert whatever it can to JPEG
  // -strip removes metadata; remove if you want to preserve EXIF
  await execFilePromise("magick", [
    inPath,
    "-auto-orient",
    "-quality",
    "100",
    outPath,
  ]);

  const jpg = await fs.readFile(outPath);

  // Normalize via sharp for consistent chromaSubsampling etc.
  return toJpegWithSharp(jpg);
}

async function pdfFirstPageToJpeg(inputBuffer, dpi = 300) {
  const id = randomUUID();
  const pdfPath = `/tmp/${id}.pdf`;
  const outPrefix = `/tmp/${id}`;

  await fs.writeFile(pdfPath, inputBuffer);

  await execFilePromise("pdftoppm", [
    "-jpeg",
    "-r",
    String(dpi),
    "-singlefile",
    pdfPath,
    outPrefix,
  ]);

  const pageJpg = await fs.readFile(`${outPrefix}.jpg`);
  return toJpegWithSharp(pageJpg);
}

// ---------- Endpoints ----------

// Single JPEG output (images + PDF first page)
app.post("/convert", async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const input = req.body;
    if (!input || input.length === 0) return res.status(400).send("Empty body");

    // PDF: always handle via poppler (pdftoppm)
    if (isPdfRequest(req)) {
      const jpeg = await pdfFirstPageToJpeg(input, 300);
      res.setHeader("Content-Type", "image/jpeg");
      return res.status(200).send(jpeg);
    }

    // Non-PDF: sharp -> ffmpeg -> magick
    try {
      const jpeg = await toJpegWithSharp(input);
      res.setHeader("Content-Type", "image/jpeg");
      return res.status(200).send(jpeg);
    } catch (e1) {
      try {
        const jpeg = await toJpegWithFfmpeg(input);
        res.setHeader("Content-Type", "image/jpeg");
        return res.status(200).send(jpeg);
      } catch (e2) {
        const jpeg = await toJpegWithMagick(input);
        res.setHeader("Content-Type", "image/jpeg");
        return res.status(200).send(jpeg);
      }
    }
  } catch (e) {
    console.error(e);
    return res.status(500).send(String(e?.stack || e));
  }
});

// PDF all pages -> ZIP of JPEG pages
app.post("/convert/pdf", async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const input = req.body;
    if (!input || input.length === 0) return res.status(400).send("Empty body");

    if (!isPdfRequest(req)) {
      return res
        .status(415)
        .send("This endpoint only accepts PDFs (Content-Type: application/pdf)");
    }

    // Safety limits
    const dpi = clampInt(req.headers["x-pdf-dpi"], 72, 600, 300);
    const maxPages = clampInt(req.headers["x-pdf-max-pages"], 1, 200, 50);

    const id = randomUUID();
    const pdfPath = `/tmp/${id}.pdf`;
    const outDir = `/tmp/${id}-pages`;
    const outPrefix = path.join(outDir, "page");

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(pdfPath, input);

    await execFilePromise("pdftoppm", ["-jpeg", "-r", String(dpi), pdfPath, outPrefix]);

    const files = (await fs.readdir(outDir))
      .filter((f) => /^page-\d+\.jpg$/i.test(f))
      .sort((a, b) => pageNum(a) - pageNum(b));

    if (files.length === 0) return res.status(500).send("PDF render produced no pages");
    if (files.length > maxPages) {
      return res.status(413).send(`PDF has ${files.length} pages; exceeds maxPages=${maxPages}`);
    }

    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="pdf-pages-${id}.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      console.error(err);
      if (!res.headersSent) res.status(500);
      res.end();
    });

    archive.pipe(res);

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const n = String(i + 1).padStart(3, "0");
      archive.append(createReadStream(path.join(outDir, f)), { name: `${n}.jpg` });
    }

    await archive.finalize();
  } catch (e) {
    console.error(e);
    return res.status(500).send(String(e?.stack || e));
  }
});

// Oversize handler
app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).send("Payload too large (max 30mb)");
  }
  return next(err);
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`converter listening on 0.0.0.0:${port}`);
});

// ---------- Helpers ----------
function execFilePromise(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || String(err)));
      else resolve();
    });
  });
}

function pageNum(filename) {
  const m = filename.match(/page-(\d+)\.jpg/i);
  return m ? Number(m[1]) : 0;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
