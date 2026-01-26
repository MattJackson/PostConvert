// server.js
import express from "express";
import sharp from "sharp";
import { execFile } from "child_process";
import fs from "fs/promises";
import { randomUUID } from "crypto";

import libheifModule from "libheif-js";
const libheif = libheifModule?.default ?? libheifModule;

const app = express();
app.use(express.raw({ type: "*/*", limit: "30mb" }));

app.get("/", (_req, res) => res.status(200).send("postconvert: ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

/* ------------------------------------------------------------------ */
/* Request context / logging                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_REQ_TIMEOUT_MS = clampInt(
  process.env.REQ_TIMEOUT_MS,
  5_000,
  10 * 60_000,
  120_000
);

const DEFAULT_REQ_TIMEOUT_PDF_MS = clampInt(
  process.env.REQ_TIMEOUT_PDF_MS,
  10_000,
  30 * 60_000,
  5 * 60_000
);

app.use((req, res, next) => {
  const requestId =
    String(req.headers["x-request-id"] || "").trim() || randomUUID();
  req.requestId = requestId;

  res.setHeader("x-request-id", requestId);

  const started = Date.now();
  req.setTimeout(DEFAULT_REQ_TIMEOUT_MS);
  res.setTimeout(DEFAULT_REQ_TIMEOUT_MS);

  res.on("finish", () => {
    const ms = Date.now() - started;
    const len =
      Number(req.headers["content-length"] || 0) ||
      (req.body?.length ?? 0) ||
      0;

    console.log(
      JSON.stringify({
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
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
    try { res.end(); } catch {}
    return;
  }
  res.status(status).json({ error: code, message, requestId });
}

/* ------------------------------------------------------------------ */
/* Auth                                                               */
/* ------------------------------------------------------------------ */

function requireAuth(req, res) {
  const token = process.env.CONVERTER_TOKEN;
  const auth = req.headers.authorization || "";
  if (!token || auth !== `Bearer ${token}`) {
    sendError(res, 401, "unauthorized", "Unauthorized", req.requestId);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Type detection                                                     */
/* ------------------------------------------------------------------ */

function isPdfRequest(req) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  const fn = String(req.headers["x-filename"] || "").toLowerCase();
  return ct.startsWith("application/pdf") || fn.endsWith(".pdf");
}

function looksLikeHeic(buf) {
  if (!buf || buf.length < 16) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
  const brands = buf.toString("ascii", 8, Math.min(buf.length, 256));
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

async function assertSupportedRaster(input) {
  if (looksLikeHeic(input)) return;
  try {
    await sharp(input, { failOnError: false }).metadata();
  } catch {
    throw Object.assign(new Error("Unsupported image input"), {
      statusCode: 415,
      code: "unsupported_media_type",
    });
  }
}

/* ------------------------------------------------------------------ */
/* Options                                                            */
/* ------------------------------------------------------------------ */

function parseBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function parseOptions(req) {
  return {
    quality: clampInt(req.headers["x-jpeg-quality"], 40, 100, 85),
    maxDim: clampInt(req.headers["x-max-dimension"], 500, 6000, 2000),
    withoutEnlargement: parseBool(req.headers["x-without-enlargement"], true),
    pdfDpi: clampInt(req.headers["x-pdf-dpi"], 72, 600, 300),
  };
}

/* ------------------------------------------------------------------ */
/* Vision-safe normalization                                          */
/* ------------------------------------------------------------------ */

function normalizeForVision(input, opts) {
  const sharpInputOpts = {
    failOnError: false,
    limitInputPixels: 200e6,
    ...(opts?.raw ? { raw: opts.raw } : {}),
  };

  let pipeline = sharp(input, sharpInputOpts)
    .rotate()
    .toColorspace("rgb");

  if (opts.maxDim) {
    pipeline = pipeline.resize({
      width: opts.maxDim,
      height: opts.maxDim,
      fit: "inside",
      withoutEnlargement: opts.withoutEnlargement,
    });
  }

  return pipeline
    .jpeg({
      quality: opts.quality,
      chromaSubsampling: "4:4:4",
      mozjpeg: true,
      progressive: true,
    })
    .withMetadata(false)
    .toBuffer();
}

/* ------------------------------------------------------------------ */
/* HEIC via WASM                                                      */
/* ------------------------------------------------------------------ */

function heifDisplayToRGBA(img) {
  return new Promise((resolve, reject) => {
    try {
      const w = img.get_width();
      const h = img.get_height();
      const rgba = new Uint8Array(w * h * 4);
      img.display({ data: rgba, width: w, height: h, channels: 4 }, () =>
        resolve({ width: w, height: h, rgba })
      );
    } catch (e) {
      reject(e);
    }
  });
}

async function heicToJpeg(input, opts) {
  if (!libheif?.HeifDecoder) throw new Error("libheif-js unavailable");
  const dec = new libheif.HeifDecoder();
  const imgs = dec.decode(input);
  if (!imgs?.length) throw new Error("HEIC decode failed");

  const { width, height, rgba } = await heifDisplayToRGBA(imgs[0]);

  return normalizeForVision(Buffer.from(rgba), {
    ...opts,
    raw: { width, height, channels: 4 },
  });
}

/* ------------------------------------------------------------------ */
/* PDF handling                                                       */
/* ------------------------------------------------------------------ */

async function pdfFirstPageToJpeg(input, opts) {
  const id = randomUUID();
  const pdf = `/tmp/${id}.pdf`;
  const out = `/tmp/${id}.jpg`;

  try {
    await fs.writeFile(pdf, input);
    await execFilePromise(
      "pdftoppm",
      ["-jpeg", "-singlefile", "-r", String(opts.pdfDpi), pdf, `/tmp/${id}`],
      DEFAULT_REQ_TIMEOUT_PDF_MS
    );
    const buf = await fs.readFile(out);
    return normalizeForVision(buf, opts);
  } finally {
    await safeUnlink(pdf);
    await safeUnlink(out);
  }
}

/* ------------------------------------------------------------------ */
/* Single-flight per machine (ONLY for /convert)                       */
/* ------------------------------------------------------------------ */

const MAX_CONVERT_INFLIGHT = 1;
let convertInflight = 0;

async function withConvertSingleFlight(req, res, fn) {
  if (convertInflight >= MAX_CONVERT_INFLIGHT) {
    res.setHeader("Retry-After", "1");
    return sendError(
      res,
      429,
      "busy",
      "Converter busy; retry shortly",
      req.requestId
    );
  }
  convertInflight++;
  try {
    return await fn();
  } finally {
    convertInflight--;
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

app.post("/convert", async (req, res) => {
  // Encourage quick socket turnover
  res.setHeader("Connection", "close");

  return withConvertSingleFlight(req, res, async () => {
    try {
      if (!requireAuth(req, res)) return;

      if (!req.body?.length) {
        return sendError(res, 400, "empty_body", "Empty body", req.requestId);
      }

      const opts = parseOptions(req);

      if (isPdfRequest(req)) {
        if (isAborted(req, res)) return;
        const jpeg = await pdfFirstPageToJpeg(req.body, opts);
        if (isAborted(req, res)) return;
        res.setHeader("Content-Type", "image/jpeg");
        return res.send(jpeg);
      }

      if (looksLikeHeic(req.body)) {
        if (isAborted(req, res)) return;
        const jpeg = await heicToJpeg(req.body, opts);
        if (isAborted(req, res)) return;
        res.setHeader("Content-Type", "image/jpeg");
        return res.send(jpeg);
      }

      await assertSupportedRaster(req.body);

      if (isAborted(req, res)) return;
      const jpeg = await normalizeForVision(req.body, opts);
      if (isAborted(req, res)) return;

      res.setHeader("Content-Type", "image/jpeg");
      return res.send(jpeg);
    } catch (e) {
      const status = e?.statusCode || 500;
      const code = e?.code || "conversion_failed";

      console.error(
        JSON.stringify({
          requestId: req.requestId,
          err: String(e?.stack || e),
        })
      );

      return sendError(
        res,
        status,
        code,
        status === 415 ? "Unsupported media type" : "Conversion failed",
        req.requestId
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function execFilePromise(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") return reject(new Error(`Missing dependency: ${cmd}`));
        if (err.killed || err.signal === "SIGTERM") {
          return reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        }
        return reject(new Error(stderr || String(err)));
      }
      resolve();
    });
  });
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function safeUnlink(p) {
  try { await fs.unlink(p); } catch {}
}

/* ------------------------------------------------------------------ */

const port = Number(process.env.PORT) || 8080;
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`converter listening on :${port}`)
);

// Reduce lingering keep-alive sockets
server.keepAliveTimeout = 5_000;
server.headersTimeout = 10_000;
