const express = require('express');
const router = express.Router();
const { calculateRate } = require('../controllers/shippingController');

// Rate calculation (public, called during checkout)
router.post('/calculate-rate', calculateRate);

module.exports = router;
