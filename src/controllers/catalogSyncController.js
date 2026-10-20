const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { buildMatcher } = require("../utils/catalogMatch");
const {
  SyncError,
  assertConfigured,
  isValidSyncKey,
  fetchClubProProducts,
  downloadImage,
  storeImage,
  removeStoredImage,
} = require("../services/catalogSyncService");

// Admin "Image Sync": pull product images from the Club Pro store instead of
// uploading them one by one. Also serves our own catalog as a feed so the
// Club Pro admin can pull images the other way.

const IMAGE_FIELDS = ["imageOne", "imageTwo", "imageThree", "imageFour"];
const ALT_FIELDS = ["imgAltOne", "imgAltTwo", "imgAltThree", "imgAltFour"];
const MAX_ITEMS_PER_REQUEST = 10;

// Stored values look like "/1771570315847-235357815.png" and are served from
// /uploads/products/. Full URLs (rare, from old imports) are kept as-is.
// CATALOG_SYNC_IMAGE_ORIGIN (local dev only) points them at the live API,
// since a local uploads/ folder has no copies of the live files.
const publicImagePath = (value) => {
  if (/^https?:\/\//i.test(value)) return value;
  const origin = (process.env.CATALOG_SYNC_IMAGE_ORIGIN || "").replace(/\/+$/, "");
  return `${origin}/uploads/products/${path.basename(value)}`;
};

async function listLocalProducts() {
  const products = await prisma.product.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: {
      brand: { select: { name: true } },
      model: { select: { name: true } },
      productType: { select: { name: true } },
    },
  });
  return products.map((p) => ({
    id: String(p.id),
    name: p.name || "",
    sku: p.sku || "",
    fishbowl: p.fishbowlPartNumber || "",
    brand: p.brand?.name || "",
    model: p.model?.name || "",
    color: p.color || "",
    type: p.productType?.name || "",
    images: IMAGE_FIELDS.map((f, i) => (p[f] ? { url: publicImagePath(p[f]), alt: p[ALT_FIELDS[i]] || "" } : null)).filter(Boolean),
  }));
}

const sendError = (res, err) => {
  if (err instanceof SyncError) return res.status(err.status).json({ message: err.message });
  console.error("Image sync error:", err);
  return res.status(500).json({ message: "Image sync failed", error: err.message });
};

// GET /api/catalog-sync/feed — machine-to-machine, guarded by the shared sync key.
// Image URLs are relative to this API's origin; the reader resolves them.
const catalogFeed = async (req, res) => {
  if (!isValidSyncKey(req.get("x-catalog-sync-key"))) {
    return res.status(401).json({ message: "Invalid catalog sync key" });
  }
  try {
    res.json({ products: await listLocalProducts() });
  } catch (err) {
    sendError(res, err);
  }
};

// GET /api/catalog-sync/preview — every local product with its suggested Club Pro match.
const previewImageSync = async (req, res) => {
  try {
    const [remote, local] = await Promise.all([fetchClubProProducts(), listLocalProducts()]);
    const match = buildMatcher(remote);
    res.json({
      source: (process.env.CLUBPRO_API_URL || "").replace(/\/+$/, ""),
      local: local.map((p) => {
        const m = match(p);
        return { ...p, match: m ? { remoteId: m.remote.id, reason: m.reason } : null };
      }),
      remote,
    });
  } catch (err) {
    sendError(res, err);
  }
};

// An old file may also be used by another product (imports can reuse file
// names), so only delete files no product points at any more.
async function deleteIfUnused(values) {
  for (const value of values) {
    const base = path.basename(value);
    const forms = [...new Set([value, `/${base}`, base])];
    const users = await prisma.product.count({
      where: { OR: IMAGE_FIELDS.map((f) => ({ [f]: { in: forms } })) },
    });
    if (users === 0) await removeStoredImage(value);
  }
}

// POST /api/catalog-sync/apply  { items: [{ productId: 12, remoteId: "enclosure:34" }] }
// Copies the Club Pro product's images (first 4) onto each local product,
// replacing its current images. A product is only updated once every image
// copied cleanly.
const applyImageSync = async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: "No products selected." });
  if (items.length > MAX_ITEMS_PER_REQUEST) return res.status(400).json({ message: `Send at most ${MAX_ITEMS_PER_REQUEST} products per request.` });
  for (const item of items) {
    if (!/^\d+$/.test(String(item?.productId)) || item.remoteId === undefined || item.remoteId === null || item.remoteId === "") {
      return res.status(400).json({ message: "Each item needs a product id and a Club Pro product id." });
    }
  }

  let remoteById;
  try {
    assertConfigured();
    remoteById = new Map((await fetchClubProProducts()).map((r) => [r.id, r]));
  } catch (err) {
    return sendError(res, err);
  }

  const results = [];
  for (const item of items) {
    const productId = Number(item.productId);
    const stored = [];
    try {
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) throw new Error("This product no longer exists.");
      const source = remoteById.get(String(item.remoteId));
      if (!source) throw new Error("The chosen Club Pro product was not found (it may have been deleted).");
      if (source.images.length === 0) throw new Error("The chosen Club Pro product has no images.");

      const images = source.images.slice(0, IMAGE_FIELDS.length);
      for (const img of images) {
        stored.push({ value: await storeImage(await downloadImage(img.url)), alt: img.alt || product.name });
      }

      const data = {};
      IMAGE_FIELDS.forEach((f, i) => {
        data[f] = stored[i]?.value ?? null;
        data[ALT_FIELDS[i]] = stored[i]?.alt ?? null;
      });
      await prisma.product.update({ where: { id: productId }, data });

      results.push({ productId, ok: true, images: stored.map((s) => ({ url: publicImagePath(s.value), alt: s.alt })) });
      // The product now uses the new files, so cleanup trouble must not undo them.
      const old = IMAGE_FIELDS.map((f) => product[f]).filter(Boolean);
      await deleteIfUnused(old).catch((err) => console.warn("Image sync cleanup failed:", err.message));
    } catch (err) {
      await Promise.all(stored.map((s) => removeStoredImage(s.value)));
      results.push({ productId, ok: false, error: err.message });
    }
  }

  res.json({ results });
};

module.exports = { catalogFeed, previewImageSync, applyImageSync };
