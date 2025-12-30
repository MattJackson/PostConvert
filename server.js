import express from "express";
import sharp from "sharp";

const app = express();

// Raw binary uploads (HEIC/JPEG/etc)
app.use(express.raw({ type: "*/*", limit: "30mb" }));

// Friendly "is it up" endpoints
app.get("/", (_req, res) => res.status(200).send("postconvert: ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/convert", async (req, res) => {
  try {
    const token = process.env.CONVERTER_TOKEN;
    const auth = req.headers.authorization || "";

    if (!token || auth !== `Bearer ${token}`) {
      return res.status(401).send("Unauthorized");
    }

    const input = req.body; // Buffer
    if (!input || input.length === 0) {
      return res.status(400).send("Empty body");
    }

    const jpeg = await sharp(input, { failOnError: false })
      .rotate() // respect EXIF orientation
      .jpeg({ quality: 85 })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    return res.status(200).send(jpeg);
  } catch (e) {
    return res.status(500).send(String(e?.stack || e));
  }
});

// Express will throw for oversized bodies; return a clean 413
app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).send("Payload too large (max 30mb)");
  }
  return next(err);
});

const port = Number(process.env.PORT) || 8080;

// IMPORTANT for Fly.io: bind to 0.0.0.0 (not localhost)
app.listen(port, "0.0.0.0", () => {
  console.log(`converter listening on ${port}`);
});
