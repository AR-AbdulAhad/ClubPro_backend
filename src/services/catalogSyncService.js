const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

// Talks to the Club Pro backend for the admin "Image Sync" page: reads its
// product feed and copies image files into uploads/products, so our products
// never depend on files Club Pro may later replace or delete.

const FEED_PATH = "/api/catalog-sync/feed";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PRODUCTS_DIR = path.join(process.cwd(), "uploads", "products");

class SyncError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const syncKey = () => process.env.CATALOG_SYNC_KEY || "";
const clubProUrl = () => (process.env.CLUBPRO_API_URL || "").replace(/\/+$/, "").replace(/\/api$/, "");

function assertConfigured() {
  if (!syncKey() || !clubProUrl()) {
    throw new SyncError(400, "Image sync is not set up. Add CATALOG_SYNC_KEY and CLUBPRO_API_URL to the backend .env (the same key must be set on the Club Pro backend).");
  }
}

/** Constant-time check of the x-catalog-sync-key header on our own feed. */
function isValidSyncKey(supplied) {
  const expected = syncKey();
  if (!expected || typeof supplied !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const absolute = (url) => {
  if (!url) return "";
  try {
    return new URL(url, clubProUrl()).href;
  } catch {
    return "";
  }
};

/** Club Pro products in the shape catalogMatch expects, with absolute image URLs. */
async function fetchClubProProducts() {
  assertConfigured();
  let res;
  try {
    res = await fetch(`${clubProUrl()}${FEED_PATH}`, {
      headers: { "x-catalog-sync-key": syncKey(), Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new SyncError(502, `Could not reach Club Pro (${clubProUrl()}): ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SyncError(502, "Club Pro rejected the sync key. CATALOG_SYNC_KEY must be identical on both backends.");
  }
  if (!res.ok) throw new SyncError(502, `Club Pro feed failed (HTTP ${res.status}).`);
  const json = await res.json().catch(() => null);
  if (!Array.isArray(json?.products)) throw new SyncError(502, "Club Pro returned an unexpected response.");

  return json.products.map((p) => ({
    id: String(p.id),
    name: p.name || "",
    altNames: Array.isArray(p.altNames) ? p.altNames : [],
    sku: p.sku || "",
    fishbowl: p.fishbowl || "",
    brand: p.brand || "",
    model: p.model || "",
    color: p.color || "",
    type: p.type || "",
    images: (p.images || [])
      .map((img) => ({ url: absolute(img.url), alt: img.alt || "" }))
      .filter((img) => /^https?:\/\//i.test(img.url)),
  }));
}

// Content type is taken from the file's own bytes; servers often send
// application/octet-stream for uploads.
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buf.length > 6 && buf.subarray(0, 4).toString("ascii") === "GIF8") return ".gif";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return null;
}

async function downloadImage(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new Error(`Could not download ${url}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status})`);
  if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error(`${url} is larger than 10 MB`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`${url} is larger than 10 MB`);
  const ext = sniffImage(buffer);
  if (!ext) throw new Error(`${url} is not a JPEG, PNG, WEBP or GIF image`);
  return { buffer, ext };
}

/** Saves into uploads/products and returns the value stored on Product.imageOne etc. */
async function storeImage({ buffer, ext }) {
  await fs.mkdir(PRODUCTS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  await fs.writeFile(path.join(PRODUCTS_DIR, filename), buffer);
  return `/${filename}`;
}

async function removeStoredImage(value) {
  if (!value || /^https?:\/\//i.test(value)) return;
  await fs.unlink(path.join(PRODUCTS_DIR, path.basename(value))).catch(() => {});
}

module.exports = {
  SyncError,
  assertConfigured,
  isValidSyncKey,
  fetchClubProProducts,
  downloadImage,
  storeImage,
  removeStoredImage,
};
