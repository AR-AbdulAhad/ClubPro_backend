const express = require('express');
const {
  getBrands,
  getBrand,
  createBrand,
  updateBrand,
  deleteBrand,
  allBrand,
  getBrandBySlug
} = require('../controllers/brandController');
const { upload } = require("../middlewares/multer");

const router = express.Router();

// Brand routes
router.get('/brands', getBrands);
router.get('/all-brands', allBrand);
router.get('/brands/:id', getBrand);
router.post('/brands', upload.brandLogo, createBrand);
router.put('/brands/:id', upload.brandLogo, updateBrand);
router.post('/bulk-delete-brands', deleteBrand);
router.get('/brands/slug/:slug', getBrandBySlug);

module.exports = router;
