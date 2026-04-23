# Imageer

Last updated: 2026-03

## Overview

Imageer is Netlify's image transformation service that powers the Image CDN. It receives image transform requests from Proxy, fetches the source image from the original host, applies transformations (resize, crop, format conversion, quality optimization), and returns the processed image.

- **Language**: Go
- **Tier**: Origin service (single region, horizontally scaled, 20–120 replicas in production)
- **Position in request chain**: Called by Proxy when an image transform is needed (not directly in the main chain)
- **Repository**: `imageer`

## Responsibilities

### Image transformation
- **Resize**: Fit within bounds (contain), crop to fill (cover), or force resize (fill/scale)
- **Format conversion**: JPEG, PNG, WebP, AVIF, GIF, Blurhash
- **Quality optimization**: Configurable quality (1–100, default 75)
- **Position control**: Crop anchor point (top, bottom, left, right, center)
- **Input formats**: JPEG, PNG, WebP, AVIF, TIFF, HEIF, GIF, SVG, ICO
- **SVG sanitization**: Removes `<script>` tags for security
- **Animated content**: Animated GIF/WebP passed through untouched (no transformation)
- **ICO conversion**: Converts ICO to PNG before processing
- **Blurhash generation**: Compact text representation of images

### Security
- URL validation: Blocks localhost, private IPs, path traversal
- Content-Security-Policy: `script-src 'none'` on all responses
- JWT authentication on all requests (api_jwt_secret)
- Source image size limit: 150 MB
- Output size limit: 8192×8192 pixels

## API

Single endpoint:
```
POST /transform
Authorization: Bearer <JWT>
Content-Type: application/json
```

Request body includes: site_id, account_id, original_host, query_params (url, w, h, fit, position, fm, q), allowed_patterns (URL allowlisting regexes), outgoing_headers.

## How it's invoked

Proxy detects image CDN requests and routes them to Imageer. The flow:
```
Client → Stargate → ATS → Proxy → Imageer → (fetch source image) → transform → response back through chain
```

## Processing pipeline

1. Parse and validate parameters (dimensions, format, quality, fit mode)
2. Fetch source image via HTTP GET (supports gzip/brotli decompression, redirects)
3. Detect image type via bimg/libvips
4. Apply transformation (resize, crop, format conversion) using libvips
5. Generate ETag from output hash
6. Return transformed image with cache headers and Netlify-Vary header

## Concurrency management

Uses semaphore-based concurrency limiting:
- Max inflight requests = `GOMAXPROCS * 3` (3 per CPU core)
- Returns 499 if queue timeout exceeded
- Tracks inflight and queued request counts via Datadog gauges
- VIPS cache disabled (`VipsCacheSetMax(0)`) to control memory

## Upstream / Downstream

- **Receives from**: Proxy (HTTP POST with transform parameters)
- **Forwards to**: Remote image origins (HTTP GET to fetch source images)

## Key packages

- `api/` — HTTP handler, transform logic (`transform.go` ~980 lines), parameter parsing, JWT auth, SVG sanitization, WebP animation detection, blurhash generation
- `config/` — Configuration loading from YAML (secrets + values)
- `flags/` — Feature flag constants (DevCycle)

## Configuration

Configured via YAML files:
- `FetchSecret` — JWT secret for image fetch requests
- `EdgeControlSecret` — For signing edgecontrol tokens
- `APISecret` — JWT secret for API authentication
- `RelativeTargetDomain` — CDN domain for image fetching (e.g., `cdn-regular-image-fetch-production.netlify.com`)

## Build and test

- **Build**: `make build` → `dist/nf-service`
- **Test**: `make test` (unit tests with golden image comparison via ImageMagick, skippable with `-short`)
- **CI**: CircleCI pipeline (test → build → Docker publish)
- **Docker**: Multi-stage build on Ubuntu 24 base with jemalloc for memory efficiency

## Dependencies

Key: bimg (libvips wrapper — core image processing), go-blurhash, brotli (decompression), go-ico (ICO conversion), etree (XML/SVG parsing), golang-jwt, OpenTelemetry, Netlify internal libraries (go-auth, go-config, go-headers, go-observability, go-flags, runtime-schemas)

## Key considerations

- Imageer does NOT serve images directly to clients — it's called by Proxy, and the response flows back through the request chain.
- The image processing engine is **libvips** (via the bimg Go wrapper). It's a C library, so memory management and concurrency control are important.
- Animated images are not transformed — they're passed through as-is to avoid quality loss and excessive processing time.
- Format negotiation uses the Accept header when no explicit format is requested, preferring modern formats (WebP, AVIF) when the client supports them.
- Production runs with GOMAXPROCS=4 and up to 120 replicas, indicating this is a CPU-intensive workload.
