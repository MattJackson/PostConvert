import express from "express";
import sharp from "sharp";
import { execFile } from "child_process";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import archiver from "archiver";

// libheif-js import can be default or module object depending on bundling
import libheifModule from "libheif-js";
const libheif = libheifModule?.default ?? libheifModule;

const app = express();
app.use(express.raw({ type: "*/*", limit: "30mb" }));

app.get("/", (_req, res) => res.status(200).send("postconvert: ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ---------------- Auth ----------------

function requireAuth(req, res) {
  const token = process.env.CONVERTER_TOKEN;
  const auth = req.headers.authorization || "";
  if (!token || auth !== `Bearer ${token}`) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

// ---------------- Type checks ----------------

function isPdfRequest(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const filename = String(req.headers["x-filename"] || "").toLowerCase();
  return contentType.startsWith("application/pdf") || filename.endsWith(".pdf");
}

function looksLikeHeic(buf) {
  // ISO-BMFF container: "ftyp" at offset 4. Scan brands for HEIF-family.
  if (!buf || buf.length < 16) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;

  // Scan more than first 32 bytes; compatible brands can appear later.
  const scanEnd = Math.min(buf.length, 256);
  const brands = buf.toString("ascii", 8, scanEnd);

  return (
    brands.includes("heic") ||
    brands.includes("heif") ||
    brands.includes("heix") ||
    brands.includes("hevc") ||
    brands.includes("hevx") ||
    brands.includes("mif1") ||
    brands.includes("msf1")
    // If you want to treat AVIF similarly, add: || brands.includes("avif")
  );
}

// ---------------- Resize / Quality options ----------------
// Headers:
//  - x-jpeg-quality: 0..100 (default 100)
//  - x-max-dimension: px (max width/height), preserves aspect (default none)
//  - x-width: px (optional)
//  - x-height: px (optional)
//  - x-fit: inside|cover|contain|fill|outside (default inside)
//  - x-without-enlargement: true|false (default true)

function parseBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function parseResizeOptions(req) {
  const quality = clampInt(req.headers["x-jpeg-quality"], 0, 100, 100);

  const width = clampInt(req.headers["x-width"], 1, 20000, 0) || null;
  const height = clampInt(req.headers["x-height"], 1, 20000, 0) || null;

  const maxDim = clampInt(req.headers["x-max-dimension"], 1, 20000, 0) || null;

  const fitRaw = String(req.headers["x-fit"] || "inside").toLowerCase();
  const fit = ["inside", "cover", "contain", "fill", "outside"].includes(fitRaw)
    ? fitRaw
    : "inside";

  const withoutEnlargement = parseBool(req.headers["x-without-enlargement"], true);

  return { quality, width, height, maxDim, fit, withoutEnlargement };
}

function applyResizeAndJpeg(pipeline, opts) {
  const { width, height, maxDim, fit, withoutEnlargement, quality } = opts;

  // Resize: explicit width/height wins; else max dimension inside box.
  if (width || height) {
    pipeline = pipeline.resize({
      width: width ?? undefined,
      height: height ?? undefined,
      fit,
      withoutEnlargement,
    });
  } else if (maxDim) {
    pipeline = pipeline.resize({
      width: maxDim,
      height: maxDim,
      fit: "inside",
      withoutEnlargement,
    });
  }

  // JPEG encode. mozjpeg requires sharp build support; if unavailable, sharp ignores it.
  return pipeline.jpeg({
    quality,
    chromaSubsampling: "4:4:4",
    mozjpeg: true,
  });
}

// ---------------- Core converters ----------------

async function toJpegWithSharp(inputBuffer, opts) {
  const pipeline = sharp(inputBuffer, {
    failOnError: false,
    limitInputPixels: 200e6, // safety
  }).rotate();

  return applyResizeAndJpeg(pipeline, opts).toBuffer();
}

function heifDisplayToRGBA(img) {
  // libheif-js uses a callback-style async `display(bufferObj, cb)`
  return new Promise((resolve, reject) => {
    try {
      const width = img.get_width();
      const height = img.get_height();

      const rgba = new Uint8Array(width * height * 4);
      const bufObj = { data: rgba, width, height, channels: 4 };

      img.display(bufObj, (out) => {
        if (!out || !out.data) {
          return reject(new Error("libheif-js display() failed (returned null)"));
        }
        return resolve({
          width,
          height,
          rgba: out.data instanceof Uint8Array ? out.data : rgba,
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function heicToJpegWithWasm(inputBuffer, opts) {
  if (!libheif?.HeifDecoder) {
    throw new Error("libheif-js not available (HeifDecoder missing)");
  }

  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(inputBuffer);

  if (!images || images.length === 0) {
    throw new Error("WASM HEIF decode produced no images");
  }

  const img = images[0];
  const { width, height, rgba } = await heifDisplayToRGBA(img);

  // Encode to JPEG with sharp (consistent output settings)
  const pipeline = sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } });
  return applyResizeAndJpeg(pipeline, opts).toBuffer();
}

async function pdfFirstPageToJpeg(inputBuffer, opts, dpi = 300) {
  const id = randomUUID();
  const pdfPath = `/tmp/${id}.pdf`;
  const outPrefix = `/tmp/${id}`;

  try {
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
    return toJpegWithSharp(pageJpg, opts);
  } finally {
    // best-effort cleanup
    await safeUnlink(pdfPath);
    await safeUnlink(`${outPrefix}.jpg`);
  }
}

// ---------------- Endpoints ----------------

// Single JPEG output (images + PDF first page)
app.post("/convert", async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const input = req.body;
    if (!input || input.length === 0) return res.status(400).send("Empty body");

    const opts = parseResizeOptions(req);

    // PDF: always handle via poppler
    if (isPdfRequest(req)) {
      const jpeg = await pdfFirstPageToJpeg(input, opts, 300);
      res.setHeader("Content-Type", "image/jpeg");
      return res.status(200).send(jpeg);
    }

    // Try sharp first (fast path)
    try {
      const jpeg = await toJpegWithSharp(input, opts);
      res.setHeader("Content-Type", "image/jpeg");
      return res.status(200).send(jpeg);
    } catch (sharpErr) {
      // If it looks like HEIC/HEIF, decode via WASM and encode to JPEG
      if (looksLikeHeic(input)) {
        const jpeg = await heicToJpegWithWasm(input, opts);
        res.setHeader("Content-Type", "image/jpeg");
        return res.status(200).send(jpeg);
      }

      // Otherwise: return the original sharp error
      throw sharpErr;
    }
  } catch (e) {
    console.error(e);
    return res.status(500).send(String(e?.stack || e));
  }
});

// PDF all pages -> ZIP of JPEG pages (supports resize/quality by re-encoding each page)
app.post("/convert/pdf", async (req, res) => {
  let archive = null;

  const id = randomUUID();
  const pdfPath = `/tmp/${id}.pdf`;
  const outDir = `/tmp/${id}-pages`;
  const outPrefix = path.join(outDir, "page");

  try {
    if (!requireAuth(req, res)) return;

    const input = req.body;
    if (!input || input.length === 0) return res.status(400).send("Empty body");

    if (!isPdfRequest(req)) {
      return res.status(415).send("This endpoint only accepts PDFs");
    }

    const opts = parseResizeOptions(req);
    const dpi = clampInt(req.headers["x-pdf-dpi"], 72, 600, 300);
    const maxPages = clampInt(req.headers["x-pdf-max-pages"], 1, 200, 50);

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(pdfPath, input);

    // Render all pages to JPG via poppler
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

    archive = archiver("zip", { zlib: { level: 6 } });

    // Abort work if client disconnects
    res.on("close", () => {
      try {
        archive?.abort();
      } catch {}
    });
    res.on("aborted", () => {
      try {
        archive?.abort();
      } catch {}
    });

    archive.on("error", (err) => {
      console.error(err);
      if (!res.headersSent) res.status(500);
      res.end();
    });

    archive.pipe(res);

    // Re-encode each rendered page with resize + quality controls, then append as buffers
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const n = String(i + 1).padStart(3, "0");
      const pagePath = path.join(outDir, f);

      const pageBuf = await fs.readFile(pagePath);
      const jpegBuf = await toJpegWithSharp(pageBuf, opts);

      archive.append(jpegBuf, { name: `${n}.jpg` });
    }

    await archive.finalize();
  } catch (e) {
    console.error(e);
    return res.status(500).send(String(e?.stack || e));
  } finally {
    // Best-effort cleanup for PDF zip path
    await safeUnlink(pdfPath);
    await safeRmrf(outDir);
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

// ---------------- Helpers ----------------

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

async function safeUnlink(p) {
  if (!p) return;
  try {
    await fs.unlink(p);
  } catch {}
}

async function safeRmrf(p) {
  if (!p) return;
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {}
}
