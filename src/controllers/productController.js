const { PrismaClient } = require("@prisma/client");
const { put, del } = require("@vercel/blob");
const prisma = new PrismaClient();
const path = require("path");
const fs = require("fs");
const fishbowl = require("../services/fishbowlService");

// ==================== CREATE PRODUCT ====================
const createProduct = async (req, res) => {
  try {
    const {
      name,
      sku,
      regularPrice,
      salePrice,
      stock = 0,
      color,
      brandId,
      modelId,
      typeId,
      weightLb,
      lengthIn,
      widthIn,
      heightIn,
      description,
      seoTitle,
      seoDescription,
      seoKeywords,
      slug,
      imgAltOne,
      imgAltTwo,
      imgAltThree,
      imgAltFour,
    } = req.body;

    if (!name || !regularPrice || !brandId || !modelId || !typeId) {
      return res.status(400).json({ message: "Required fields missing" });
    }

    const parsedRegularPrice = parseFloat(regularPrice);
    const parsedSalePrice = salePrice ? parseFloat(salePrice) : null;
    const parsedStock = parseInt(stock, 10);
    const parsedBrandId = parseInt(brandId, 10);
    const parsedModelId = parseInt(modelId, 10);
    const parsedTypeId = parseInt(typeId, 10);
    const parsedWeightLb = weightLb ? parseFloat(weightLb) : null;
    const parsedLengthIn = lengthIn ? parseFloat(lengthIn) : null;
    const parsedWidthIn = widthIn ? parseFloat(widthIn) : null;
    const parsedHeightIn = heightIn ? parseFloat(heightIn) : null;

    // Validation
    if (isNaN(parsedRegularPrice) || parsedRegularPrice <= 0) {
      return res.status(400).json({ message: "regularPrice must be > 0" });
    }

    const imageFields = { imageOne: null, imageTwo: null, imageThree: null, imageFour: null };
    const uploadedFiles = req.files || [];
    if (uploadedFiles.length > 4) {
      return res.status(400).json({ message: "Max 4 images allowed" });
    }

    uploadedFiles.forEach((file, index) => {
      if (index < 4) {
        const field = `image${['One','Two','Three','Four'][index]}`;
        imageFields[field] = `${file.filename}`;
      }
    });

    const product = await prisma.product.create({
      data: {
        name: name.trim(),
        sku: sku?.trim() || null,
        regularPrice: parsedRegularPrice,
        salePrice: parsedSalePrice,
        stock: parsedStock,
        color: color?.trim() || null,
        brandId: parsedBrandId,
        modelId: parsedModelId,
        typeId: parsedTypeId,
        weightLb: parsedWeightLb,
        lengthIn: parsedLengthIn,
        widthIn: parsedWidthIn,
        heightIn: parsedHeightIn,
        description: description?.trim() || null,
        seoTitle, seoDescription, seoKeywords, slug,
        ...imageFields,
        imgAltOne, imgAltTwo, imgAltThree, imgAltFour,
      },
      include: { brand: { select: { name: true } }, model: { select: { name: true } }, productType: { select: { name: true } } },
    });

    // ─── Sync with Fishbowl ───
    try {
      const fbResult = await fishbowl.syncProduct(product);
      if (fbResult?.partNumber) {
        await prisma.product.update({
          where: { id: product.id },
          data: { fishbowlPartNumber: fbResult.partNumber },
        });
        product.fishbowlPartNumber = fbResult.partNumber;
        console.log(`[Fishbowl Sync] Product ${product.id} successfully synced as part "${fbResult.partNumber}"`);
      }
    } catch (fbErr) {
      console.error(`[Fishbowl Sync Warning] Failed to sync product ${product.id} to Fishbowl:`, fbErr.message);
    }

    res.status(201).json({ message: "Product created", product });
  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ message: "Failed to create product", error: error.message });
  }
};
// ==================== BULK CREATE ===================


// ==================== UPDATE PRODUCT ====================
const updateProduct = async (req, res) => {
  const { id } = req.params;
  const {
    name, sku, regularPrice, salePrice, stock, color, brandId, modelId, typeId,
    weightLb, lengthIn, widthIn, heightIn, description, seoTitle,
    seoDescription, seoKeywords, slug, imgAltOne, imgAltTwo, imgAltThree, imgAltFour,
  } = req.body;

  try {
    const productId = parseInt(id);
    const existing = await prisma.product.findUnique({ where: { id: productId } });
    if (!existing) return res.status(404).json({ message: "Product not found" });

    const currentImages = {
      imageOne: existing.imageOne,
      imageTwo: existing.imageTwo,
      imageThree: existing.imageThree,
      imageFour: existing.imageFour,
    };

    const imageFields = ["imageOne", "imageTwo", "imageThree", "imageFour"];
    for (const field of imageFields) {
      const file = req.files?.[field]?.[0];
      const remove = req.body[`remove_${field}`] === 'true';

      if (remove && currentImages[field]) {
        const oldPath = path.join(process.cwd(), "uploads", "products", path.basename(currentImages[field]));
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        currentImages[field] = null;
      } else if (file) {
        if (currentImages[field]) {
          const oldPath = path.join(process.cwd(), "uploads", "products", path.basename(currentImages[field]));
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        currentImages[field] = `/${file.filename}`;
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (sku !== undefined) updateData.sku = sku?.trim() || null;
    if (regularPrice !== undefined) updateData.regularPrice = parseFloat(regularPrice);
    if (salePrice !== undefined) updateData.salePrice = salePrice ? parseFloat(salePrice) : null;
    if (stock !== undefined) updateData.stock = parseInt(stock, 10);
    if (color !== undefined) updateData.color = color?.trim() || null;
    if (brandId !== undefined) updateData.brandId = parseInt(brandId, 10);
    if (modelId !== undefined) updateData.modelId = parseInt(modelId, 10);
    if (typeId !== undefined) updateData.typeId = parseInt(typeId, 10);
    if (weightLb !== undefined) updateData.weightLb = weightLb ? parseFloat(weightLb) : null;
    if (lengthIn !== undefined) updateData.lengthIn = lengthIn ? parseFloat(lengthIn) : null;
    if (widthIn !== undefined) updateData.widthIn = widthIn ? parseFloat(widthIn) : null;
    if (heightIn !== undefined) updateData.heightIn = heightIn ? parseFloat(heightIn) : null;
    if (description !== undefined) updateData.description = description?.trim() || null;
    if (seoTitle !== undefined) updateData.seoTitle = seoTitle?.trim() || null;
    if (seoDescription !== undefined) updateData.seoDescription = seoDescription?.trim() || null;
    if (seoKeywords !== undefined) updateData.seoKeywords = seoKeywords?.trim() || null;
    if (slug !== undefined) updateData.slug = slug?.trim() || null;
    if (imgAltOne !== undefined) updateData.imgAltOne = imgAltOne?.trim() || null;
    if (imgAltTwo !== undefined) updateData.imgAltTwo = imgAltTwo?.trim() || null;
    if (imgAltThree !== undefined) updateData.imgAltThree = imgAltThree?.trim() || null;
    if (imgAltFour !== undefined) updateData.imgAltFour = imgAltFour?.trim() || null;

    Object.assign(updateData, currentImages);

    const updatedProduct = await prisma.product.update({
      where: { id: productId },
      data: updateData,
      include: { brand: { select: { name: true } }, model: { select: { name: true } }, productType: { select: { name: true } } },
    });

    res.status(200).json({ message: "Product updated", product: updatedProduct });
  } catch (error) {
    console.error("Update product error:", error);
    if (error.code === 'P2002' && (error.meta?.target?.includes('sku') || String(error.message).includes('sku'))) {
      return res.status(400).json({ message: `SKU "${sku}" is already assigned to another product.` });
    }
    res.status(500).json({ message: "Failed to update product", error: error.message });
  }
};

// ==================== BULK UPDATE ====================


// ==================== BULK DELETE ====================
const bulkDeleteProducts = async (req, res) => {
  const { ids } = req.body;

  try {
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "Product IDs are required" });
    }

    const parsedIds = ids.map((id) => parseInt(id));

    // Find products before deletion to retrieve their SKU/fishbowlPartNumber
    const productsToDelete = await prisma.product.findMany({
      where: { id: { in: parsedIds } },
      select: { id: true, sku: true, fishbowlPartNumber: true },
    });

    const result = await prisma.product.deleteMany({
      where: { id: { in: parsedIds } },
    });

    // Asynchronously deactivate each product in Fishbowl
    for (const prod of productsToDelete) {
      const fbPartNum = prod.fishbowlPartNumber || prod.sku;
      if (fbPartNum) {
        fishbowl.deactivateProduct(fbPartNum).catch((err) => {
          console.error(`[Fishbowl Deactivate Error for ${fbPartNum}]:`, err.message);
        });
      }
    }

    res.status(200).json({
      message: `Deleted ${result.count} product(s) successfully`,
      count: result.count,
    });
  } catch (error) {
    console.error("Error bulk deleting products:", error);
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

// ==================== GET ALL (PAGINATED) ====================
const getAllProductsPagination = async (req, res) => {
  const {
    page = 1,
    limit = 10,
    search = "",
    sort = "id",
    order = "desc",
    brand,
    modelId,
  } = req.query;

  const skip = (page - 1) * limit;

  try {
    const where = {
      // 🔍 Search filter
      ...(search && {
        OR: [
          { name: { contains: search } },
          { seoTitle: { contains: search } },
          { seoKeywords: { contains: search } },
          { slug: { contains: search } },
          { brand: { name: { contains: search } } },
          { model: { name: { contains: search } } },
        ],
      }),

      // 🏷 Brand filter
      ...(brand && {
        brand: {
          name: {
            equals: brand,
          },
        },
      }),

      // 🧩 Model filter
      ...(modelId && {
        modelId: Number(modelId),
      }),
    };

    const [products, totalItems] = await Promise.all([
      prisma.product.findMany({
        where,
        skip: Number(skip),
        take: Number(limit),
        orderBy: { [sort]: order.toLowerCase() },
        include: {
          brand: { select: { name: true } },
          model: { select: { name: true } },
          productType: { select: { name: true } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    res.status(200).json({
      data: products,
      pagination: {
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
        currentPage: Number(page),
        limit: Number(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ==================== GET BY ID ====================
const getProductById = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await prisma.product.findUnique({
      where: { id: parseInt(id) },
      include: {
        brand: { select: { id: true, name: true } },
        model: { select: { id: true, name: true } },
        productType: { select: { id: true, name: true } },
      },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json(product);
  } catch (error) {
    console.error("Error fetching product:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ==================== GET BY SLUG ====================
const getProductBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await prisma.product.findUnique({
      where: { slug: slug },
      include: {
        brand: { select: { id: true, name: true } },
        model: { select: { id: true, name: true } },
        productType: { select: { id: true, name: true } },
      },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json(product);
  } catch (error) {
    console.error("Error fetching product by slug:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ==================== GET LATEST ====================
const getLatestProducts = async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        brand: { select: { name: true } },
        model: { select: { name: true } },
        productType: { select: { name: true } },
      },
    });

    res.status(200).json(products);
  } catch (error) {
    console.error("Error fetching latest products:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ==================== TOGGLE STOCK (PATCH) ====================
const toggleProductStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { stock } = req.body; // boolean or number

    const product = await prisma.product.findUnique({
      where: { id: parseInt(id) },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const newStock = stock !== undefined ? parseInt(stock) : product.stock;

    const updated = await prisma.product.update({
      where: { id: parseInt(id) },
      data: { stock: newStock },
    });

    res.json({ message: "Stock updated successfully", product: updated });
  } catch (error) {
    console.error("Error toggling stock:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

// ==================== CSV IMPORT ====================
// Accepts rows in the same format as "Export All Products" (the master sheet).
// Matches existing products by ID -> SKU -> (name, brand, model, type, color)
// and updates them; otherwise creates a new product. Only columns present in
// the CSV are written on update, so partial sheets don't wipe other fields.
const looseKey = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const csvStr = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

const csvNum = (v, field, isInt = false) => {
  if (v === undefined) return undefined;
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in "${field}": ${v}`);
  return isInt ? Math.trunc(n) : n;
};

const importProductsFromCSV = async (req, res) => {
  const { products, autoCreate = false } = req.body;

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ message: "No products provided" });
  }

  try {
    const [brands, types, models] = await Promise.all([
      prisma.brand.findMany({ select: { id: true, name: true } }),
      prisma.productType.findMany({ select: { id: true, name: true } }),
      prisma.model.findMany({ select: { id: true, name: true, brandId: true } }),
    ]);

    // Exact (case-insensitive) match first, then loose match ignoring spaces/punctuation
    // so "Ez-Go" matches "E-Z-GO" and "Club Car" matches "ClubCar".
    const findByName = (list, name) => {
      const lower = String(name).trim().toLowerCase();
      return (
        list.find((x) => x.name.trim().toLowerCase() === lower) ||
        list.find((x) => looseKey(x.name) === looseKey(name))
      );
    };

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < products.length; i++) {
      const row = products[i];
      const rowNo = row._row ?? i + 1;
      const name = csvStr(row.name);

      try {
        const brandName = csvStr(row.brand);
        const modelName = csvStr(row.model);
        const typeName = csvStr(row.type);

        if (!name || !brandName || !modelName || !typeName) {
          throw new Error("Name, Brand, Model and Type are required");
        }

        let brand = findByName(brands, brandName);
        if (!brand) {
          if (!autoCreate) throw new Error(`Brand "${brandName}" not found`);
          brand = await prisma.brand.create({ data: { name: brandName }, select: { id: true, name: true } });
          brands.push(brand);
        }

        let type = findByName(types, typeName);
        if (!type) {
          if (!autoCreate) throw new Error(`Product Type "${typeName}" not found`);
          type = await prisma.productType.create({ data: { name: typeName }, select: { id: true, name: true } });
          types.push(type);
        }

        let model = findByName(
          models.filter((m) => m.brandId === brand.id),
          modelName
        );
        if (!model) {
          if (!autoCreate) throw new Error(`Model "${modelName}" not found for brand "${brand.name}"`);
          model = await prisma.model.create({
            data: { name: modelName, brandId: brand.id },
            select: { id: true, name: true, brandId: true },
          });
          models.push(model);
        }

        const sku = csvStr(row.sku);
        const color = csvStr(row.color);

        const data = {
          name,
          brandId: brand.id,
          modelId: model.id,
          typeId: type.id,
          sku,
          color,
          stock: csvNum(row.stock, "Stock", true),
          regularPrice: csvNum(row.regularPrice, "Regular Price"),
          salePrice: csvNum(row.salePrice, "Sale Price"),
          weightLb: csvNum(row.weightLb, "Weight (lb)"),
          lengthIn: csvNum(row.lengthIn, "Length (in)"),
          widthIn: csvNum(row.widthIn, "Width (in)"),
          heightIn: csvNum(row.heightIn, "Height (in)"),
          description: csvStr(row.description),
          seoTitle: csvStr(row.seoTitle),
          seoDescription: csvStr(row.seoDescription),
          seoKeywords: csvStr(row.seoKeywords),
          slug: csvStr(row.slug),
          imageOne: csvStr(row.imageOne),
          imgAltOne: csvStr(row.imgAltOne),
          imageTwo: csvStr(row.imageTwo),
          imgAltTwo: csvStr(row.imgAltTwo),
          imageThree: csvStr(row.imageThree),
          imgAltThree: csvStr(row.imgAltThree),
          imageFour: csvStr(row.imageFour),
          imgAltFour: csvStr(row.imgAltFour),
          fishbowlPartNumber: csvStr(row.fishbowlPartNumber),
        };

        // Drop columns that weren't in the CSV so updates don't touch them
        Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

        // ---------- Find existing: ID -> SKU -> composite ----------
        let existing = null;
        const id = csvNum(row.id, "ID", true);
        if (id) existing = await prisma.product.findUnique({ where: { id } });
        if (!existing && sku) existing = await prisma.product.findUnique({ where: { sku } });
        if (!existing) {
          existing = await prisma.product.findFirst({
            where: {
              name,
              brandId: brand.id,
              modelId: model.id,
              typeId: type.id,
              color: color ?? null,
            },
          });
        }

        if (existing) {
          if (data.regularPrice === null) delete data.regularPrice;
          if (data.stock === null) data.stock = 0;
          if (data.description === null) data.description = "";
          await prisma.product.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          await prisma.product.create({
            data: {
              ...data,
              stock: data.stock ?? 0,
              regularPrice: data.regularPrice ?? 0,
              description: data.description ?? "",
            },
          });
          created++;
        }
      } catch (err) {
        skipped++;
        let message = err.message;
        if (err.code === "P2002") {
          const target = String(err.meta?.target ?? "");
          message = `Duplicate value for unique field (${target || "sku/slug/fishbowl part"}) — already used by another product`;
        } else if (err.code) {
          message = message.split("\n").filter(Boolean).pop();
        }
        errors.push({ row: rowNo, name: name || "", message });
      }
    }

    res.json({
      success: true,
      created,
      updated,
      skipped,
      errors,
      totalProcessed: products.length,
    });
  } catch (error) {
    console.error("CSV import failed:", error);
    res.status(500).json({
      message: "CSV import failed",
      error: error.message,
    });
  }
};


module.exports = {
  importProductsFromCSV,
  createProduct,
  updateProduct,
  bulkDeleteProducts,
  getAllProductsPagination,
  getProductById,
  getProductBySlug,
  getLatestProducts,
  toggleProductStock, // renamed for clarity
};
