import express from "express";
import sharp from "sharp";

const app = express();

app.use(express.raw({ type: "*/*", limit: "30mb" }));

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/convert", async (req, res) => {
  try {
    const token = process.env.CONVERTER_TOKEN;
    const auth = req.headers.authorization || "";
    if (!token || auth !== `Bearer ${token}`) {
      return res.status(401).send("Unauthorized");
    }

    const input = req.body; // Buffer
    if (!input || input.length === 0) return res.status(400).send("Empty body");

    const jpeg = await sharp(input, { failOnError: false })
      .rotate() // respect EXIF orientation
      .jpeg({ quality: 85 })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    res.status(200).send(jpeg);
  } catch (e) {
    res.status(500).send(String(e?.stack || e));
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`converter listening on ${port}`));
