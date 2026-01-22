import express from "express";
import sharp from "sharp";
import { execFile } from "child_process";
import fs from "fs/promises";
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

// ---------------- Request context / logging ----------------

const DEFAULT_REQ_TIMEOUT_MS = clampInt(process.env.REQ_TIMEOUT_MS, 5_000, 10 * 60_000, 120_000);

app.use((req, res, next) => {
  const requestId = String(req.headers["x-request-id"] || "").trim() || randomUUID();
  req.requestId = requestId;

  res.setHeader("x-request-id", requestId);

  const started = Date.now();
  req.setTimeout(DEFAULT_REQ_TIMEOUT_MS);
  res.setTimeout(DEFAULT_REQ_TIMEOUT_MS);

  res.on("finish", () => {
    const ms = Date.now() - started;
    const len = Number(req.headers["content-length"] || 0) || (req.body?.length ?? 0) || 0;
    console.log(
      JSON.stringify({
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        contentType: req.headers["content-type"] || null,
        bytesIn: len,
        ms,
      })
    );
  });

  next();
});

function isAborted(req, res) {
  return Boolean(req.aborted || res.writableEnded || res.destroyed);
}

function sendError(res, status, code, message, requestId) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify({ error: code, message, requestId }));
}

// ---------------- Auth ----------------

function requireAuth(req, res) {
  const token = process.env.CONVERTER_TOKEN;
  const auth = req.headers.authorization || "";
  if (!token || auth !== `Bearer ${token}`) {
    sendError(res, 401, "unauthorized", "Unauthorized", req.requestId);
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
  );
}

async function assertSupportedRasterImage(input, req) {
  // If it’s HEIC/HEIF, sharp may fail metadata; allow it through to WASM path.
  if (looksLikeHeic(input)) return;

  // Quick probe: if sharp can’t read metadata, treat it as unsupported (415).
  try {
    await sharp(input, { failOnError: false }).metadata();
  } catch {
    const ct = String(req.headers["content-type"] || "unknown");
    throw Object.assign(new Error(`Unsupported input (not a decodable image). content-type=${ct}`), {
      statusCode: 415,
      code: "unsupported_media_type",
    });
  }
}

// ---------------- Resize / Quality options ----------------
// Headers:
//  - x-jpeg-quality: 0..100 (default 100)
//  - x-max-dimension: px (max width/height), preserves aspect (default none)
//  - x-width: px (optional)
//  - x-height: px (optional)
//  - x-fit: inside|cover|contain|fill|outside (default inside)
//  - x-without-enlargement: true|false (default true)
//
// PDF headers:
//  - x-pdf-dpi: 72..600 (default 300)
//  - x-pdf-max-pages: 1..200 (default 50)

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
  const fit = ["inside", "cover", "contain", "fill", "outside"].includes(fitRaw) ? fitRaw : "inside";

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

  return pipeline.jpeg({
    quality,
    chromaSubsampling: "4:4:4",
    mozjpeg: true,
    progressive: true,
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

    await execFilePromise("pdftoppm", ["-jpeg", "-r", String(dpi), "-singlefile", pdfPath, outPrefix]);

    const pageJpg = await fs.readFile(`${outPrefix}.jpg`);
    return toJpegWithSharp(pageJpg, opts);
  } finally {
    await safeUnlink(pdfPath);
    await safeUnlink(`${outPrefix}.jpg`);
  }
}

// ---------------- Endpoints ----------------

// Single JPEG output (images + PDF first page)
app.post("/convert", async (req, res) => {
  const requestId = req.requestId;

  try {
    if (!requireAuth(req, res)) return;
    if (isAborted(req, res)) return;

    const input = req.body;
    if (!input || input.length === 0) {
      return sendError(res, 400, "empty_body", "Empty body", requestId);
    }

    const opts = parseResizeOptions(req);

    // PDF: handle via poppler
    if (isPdfRequest(req)) {
      const jpeg = await pdfFirstPageToJpeg(input, opts, 300);
      if (isAborted(req, res)) return;

      res.setHeader("Content-Type", "image/jpeg");
      return res.status(200).send(jpeg);
    }

    // Non-PDF: validate input is a decodable raster image (or HEIC)
    await assertSupportedRasterImage(input, req);

    // Try sharp first (fast path)
    try {
      const jpeg = await toJpegWithSharp(input, opts);
      if (isAborted(req, res)) return;

      res.setHeader("Content-Type", "image/jpeg");
      return res.status(200).send(jpeg);
    } catch (sharpErr) {
      // If it looks like HEIC/HEIF, decode via WASM and encode to JPEG
      if (looksLikeHeic(input)) {
        const jpeg = await heicToJpegWithWasm(input, opts);
        if (isAborted(req, res)) return;

        res.setHeader("Content-Type", "image/jpeg");
        return res.status(200).send(jpeg);
      }
      throw sharpErr;
    }
  } catch (e) {
    // Expected 415 from probe
    if (e?.statusCode === 415) {
      return sendError(res, 415, e.code || "unsupported_media_type", e.message, requestId);
    }

    console.error(JSON.stringify({ requestId, err: String(e?.stack || e) }));

    // Don’t leak stack traces to clients
    return sendError(res, 500, "conversion_failed", "Conversion failed", requestId);
  }
});

// PDF all pages -> ZIP of JPEG pages (supports resize/quality by re-encoding each page)
app.post("/convert/pdf", async (req, res) => {
  const requestId = req.requestId;

  // More time for multi-page zips
  req.setTimeout(clampInt(process.env.REQ_TIMEOUT_PDF_MS, 10_000, 30 * 60_000, 5 * 60_000));
  res.setTimeout(clampInt(process.env.REQ_TIMEOUT_PDF_MS, 10_000, 30 * 60_000, 5 * 60_000));

  let archive = null;

  const id = randomUUID();
  const pdfPath = `/tmp/${id}.pdf`;
  const outDir = `/tmp/${id}-pages`;
  const outPrefix = path.join(outDir, "page");

  try {
    if (!requireAuth(req, res)) return;
    if (isAborted(req, res)) return;

    const input = req.body;
    if (!input || input.length === 0) {
      return sendError(res, 400, "empty_body", "Empty body", requestId);
    }

    if (!isPdfRequest(req)) {
      return sendError(res, 415, "unsupported_media_type", "This endpoint only accepts PDFs", requestId);
    }

    const opts = parseResizeOptions(req);
    const dpi = clampInt(req.headers["x-pdf-dpi"], 72, 600, 300);
    const maxPages = clampInt(req.headers["x-pdf-max-pages"], 1, 200, 50);

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(pdfPath, input);

    if (isAborted(req, res)) return;

    // Render all pages to JPG via poppler
    await execFilePromise("pdftoppm", ["-jpeg", "-r", String(dpi), pdfPath, outPrefix]);

    const files = (await fs.readdir(outDir))
      .filter((f) => /^page-\d+\.jpg$/i.test(f))
      .sort((a, b) => pageNum(a) - pageNum(b));

    if (files.length === 0) return sendError(res, 500, "pdf_render_failed", "PDF render produced no pages", requestId);
    if (files.length > maxPages) {
      return sendError(
        res,
        413,
        "pdf_too_many_pages",
        `PDF has ${files.length} pages; exceeds maxPages=${maxPages}`,
        requestId
      );
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
      console.error(JSON.stringify({ requestId, err: String(err?.stack || err) }));
      try {
        if (!res.headersSent) sendError(res, 500, "zip_failed", "ZIP creation failed", requestId);
        else res.end();
      } catch {}
    });

    archive.pipe(res);

    // Re-encode each rendered page with resize + quality controls, then append as buffers
    for (let i = 0; i < files.length; i++) {
      if (isAborted(req, res)) break;

      const f = files[i];
      const n = String(i + 1).padStart(3, "0");
      const pagePath = path.join(outDir, f);

      const pageBuf = await fs.readFile(pagePath);
      const jpegBuf = await toJpegWithSharp(pageBuf, opts);

      if (isAborted(req, res)) break;

      archive.append(jpegBuf, { name: `${n}.jpg` });
    }

    if (!isAborted(req, res)) {
      await archive.finalize();
    }
  } catch (e) {
    console.error(JSON.stringify({ requestId, err: String(e?.stack || e) }));

    // If we already started streaming a zip, we can’t reliably send JSON.
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }

    // ENOENT (pdftoppm missing) or other exec failures should be clear, but still not leak stack.
    const msg =
      String(e?.message || "").includes("Missing dependency: pdftoppm") ||
      String(e?.message || "").includes("ENOENT")
        ? "Server missing PDF rendering dependency"
        : "Conversion failed";

    return sendError(res, 500, "conversion_failed", msg, requestId);
  } finally {
    await safeUnlink(pdfPath);
    await safeRmrf(outDir);
  }
});

// Oversize handler
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return sendError(res, 413, "payload_too_large", "Payload too large (max 30mb)", req.requestId);
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
      if (err) {
        // Provide clearer missing-binary errors
        if (err.code === "ENOENT") {
          return reject(new Error(`Missing dependency: ${cmd} (not found in PATH)`));
        }
        const meta = `cmd=${cmd} code=${err.code || "unknown"} signal=${err.signal || "none"}`;
        return reject(new Error(`${meta}${stderr ? `; stderr=${stderr}` : ""}`));
      }
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
