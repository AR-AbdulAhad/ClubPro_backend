const {
  createProduct,
  bulkCreateProducts,
  updateProduct,
  bulkUpdateProducts,
  bulkDeleteProducts,
  getAllProductsPagination,
  getProductById,
  getProductBySlug,
  getLatestProducts,
  importProductsFromCSV,
  syncInventoryFromFishbowl,
  // toggleProductField,
} = require('../controllers/productController');

const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { upload } = require("../middlewares/multer");


// ==================== AUTHENTICATED ROUTES (Admin/Staff) ====================

// Create single product
router.post('/create-product', authenticateToken, upload.productImages, createProduct);

// Bulk create products
// router.post('/bulk-create-products', authenticateToken, bulkCreateProducts);

// Bulk update products (e.g., stock, prices, brand)
// router.patch('/bulk-update-products', authenticateToken, bulkUpdateProducts);

// Bulk delete products
router.post('/bulk-delete-products', authenticateToken, bulkDeleteProducts);

// Update single product
router.put('/product/:id', authenticateToken, upload.productNamedImages, updateProduct);

router.post("/products/import-csv", importProductsFromCSV);

// Fishbowl Inventory Sync routes
router.post('/products/sync-inventory', syncInventoryFromFishbowl);
router.post('/products/:id/sync-inventory', syncInventoryFromFishbowl);


// Toggle stock (or any simple field)
// router.patch('/product/:id/toggle', authenticateToken, toggleProductField);

// Get all products with pagination, search, and sorting (admin view)
router.get(
  '/product-all-pagination',
  // authenticateToken,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('search').optional().isString().trim(),
    query('sort').optional().isIn(['id', 'name', 'regularPrice', 'salePrice', 'stock', 'createdAt']),
    query('order').optional().isIn(['asc', 'desc']),
  ],
  getAllProductsPagination
);

// ==================== PUBLIC ROUTES ====================

// Get paginated products (public - basic listing)
router.get('/products', getAllProductsPagination); // Reusing the same logic, no auth needed for public

// Get single product by ID
router.get('/product/:id', getProductById);

// Get single product by Slug
router.get('/product/slug/:slug', getProductBySlug);

// Get latest products (homepage/feature)
router.get('/product/latest', getLatestProducts);

module.exports = router;