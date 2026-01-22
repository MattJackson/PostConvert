# PostConvert – Robust Image & PDF → JPEG Conversion Service

PostConvert is a small, production-oriented HTTP service for converting **images and PDFs into JPEGs**, with strong emphasis on **robustness, predictable resource usage, and operational safety**.

It supports:
- JPEG → JPEG (resize + recompress)
- PNG / WebP / TIFF → JPEG
- HEIC / HEIF → JPEG (via WASM fallback)
- PDF → JPEG (first page or all pages as a ZIP)

The service is designed to run well in **containers, serverless-ish environments, and small VMs** where disk, memory, and runaway workloads matter.

---

## Primary Use Cases

- Normalize user uploads (receipts, photos, scans) into JPEG
- Resize and recompress images server-side for storage or ML pipelines
- Convert PDFs (receipts, invoices, statements) into images
- Handle HEIC uploads from iOS devices without native libheif dependencies
- Safely process untrusted user uploads with bounded resource usage

---

## Key Design Goals

- **Always JPEG out**
- **Bounded `/tmp` usage** (PDFs rendered page-by-page)
- **No stack traces leaked to clients**
- **Fast path for common formats**
- **Graceful abort on client disconnect**
- **Predictable limits** (size, pages, DPI, timeouts)

---

## Endpoints

### `POST /convert`

Converts a single image **or the first page of a PDF** to a JPEG.

#### Supported inputs
- JPEG, PNG, WebP, TIFF, etc. (anything Sharp can decode)
- HEIC / HEIF
- PDF (first page only)

#### Response
- `200 image/jpeg` on success
- JSON error on failure

---

### `POST /convert/pdf`

Converts **all pages of a PDF** into JPEGs and returns a ZIP archive.

Pages are rendered **one at a time** to keep disk usage bounded.

---

## Authentication

All endpoints require a bearer token.

```
Authorization: Bearer <CONVERTER_TOKEN>
```

---

## Image Resize & JPEG Options (Headers)

| Header | Type | Default | Description |
|------|-----|--------|-------------|
| `x-jpeg-quality` | `0–100` | `100` | JPEG compression quality |
| `x-max-dimension` | px | none | Max width/height, aspect preserved |
| `x-width` | px | none | Explicit output width |
| `x-height` | px | none | Explicit output height |
| `x-fit` | enum | `inside` | `inside`, `cover`, `contain`, `fill`, `outside` |
| `x-without-enlargement` | bool | `true` | Prevent upscaling smaller images |

---

## Environment Variables

| Variable | Default | Description |
|-------|--------|------------|
| `PORT` | `8080` | Server port |
| `CONVERTER_TOKEN` | (required) | Bearer auth token |

---

## Runtime Dependencies

- Node.js 18+
- `pdftoppm` (Poppler utils) **required for PDFs**
- Sharp native dependencies (per Sharp docs)
