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

// --- Endpoint 1: images (and PDF first page) -> single JPEG ---
app.post("/convert", async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const input = req.body;
    if (!input || input.length === 0) return res.status(400).send("Empty body");

    const contentType = (req.headers["content-type"] || "").toLowerCase();
    const filename = (req.headers["x-filename"] || "").toLowerCase();
    const isPdf = contentType === "application/pdf" || filename.endsWith(".pdf");

    let imageBuffer = input;

    if (isPdf) {
      // PDF -> first page JPEG at 300 DPI
      const id = randomUUID();
      const pdfPath = `/tmp/${id}.pdf`;
      const outPrefix = `/tmp/${id}`; // output will be `${outPrefix}.jpg`

      await fs.writeFile(pdfPath, input);

      await execFilePromise("pdftoppm", [
        "-jpeg",
        "-r",
        "300",
        "-singlefile",
        pdfPath,
        outPrefix,
      ]);

      imageBuffer = await fs.readFile(`${outPrefix}.jpg`);
    }

    const jpeg = await sharp(imageBuffer, { failOnError: false })
      .rotate()
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    return res.status(200).send(jpeg);
  } catch (e) {
    console.error(e);
    return res.status(500).send(String(e?.stack || e));
  }
});

// --- Endpoint 2: PDF all pages -> ZIP of JPEG pages ---
app.post("/convert/pdf", async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const input = req.body;
    if (!input || input.length === 0) return res.status(400).send("Empty body");

    const contentType = (req.headers["content-type"] || "").toLowerCase();
    const filename = (req.headers["x-filename"] || "").toLowerCase();
    const isPdf = contentType === "application/pdf" || filename.endsWith(".pdf");

    if (!isPdf) {
      return res.status(415).send("This endpoint only accepts PDFs (Content-Type: application/pdf)");
    }

    // Safety limits (tweak as you like)
    const dpi = clampInt(req.headers["x-pdf-dpi"], 72, 600, 300);
    const maxPages = clampInt(req.headers["x-pdf-max-pages"], 1, 50, 20);

    const id = randomUUID();
    const pdfPath = `/tmp/${id}.pdf`;
    const outDir = `/tmp/${id}-pages`;
    const outPrefix = path.join(outDir, "page"); // produces page-1.jpg, page-2.jpg, ...

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(pdfPath, input);

    // Render all pages to JPEG files
    await execFilePromise("pdftoppm", [
      "-jpeg",
      "-r",
      String(dpi),
      pdfPath,
      outPrefix,
    ]);

    // Collect rendered pages
    const files = (await fs.readdir(outDir))
      .filter((f) => /^page-\d+\.jpg$/i.test(f))
      .sort((a, b) => pageNum(a) - pageNum(b));

    if (files.length === 0) {
      return res.status(500).send("PDF render produced no pages");
    }
    if (files.length > maxPages) {
      return res
        .status(413)
        .send(`PDF has ${files.length} pages; exceeds maxPages=${maxPages}`);
    }

    // Stream a ZIP back
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="pdf-pages-${id}.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      console.error(err);
      if (!res.headersSent) res.status(500);
      res.end();
    });

    archive.pipe(res);

    // Add each page file to the zip as 001.jpg, 002.jpg, ...
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
