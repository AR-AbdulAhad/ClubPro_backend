// routes/orderRoutes.js
const express = require("express");
const router = express.Router();
const bodyParser = require("body-parser");
const {
  stripeWebhook,
  stripeSession,
  getOrders,
  getOrderById,
  updateStatus,
  bulkCancel,
  updateOrderTracking,
} = require("../controllers/orderController");
const { authenticateToken } = require("../middlewares/authMiddleware");

// router.post(
//   "/stripe/webhook",
//   express.raw({ type: "application/json" }),
//   stripeWebhook
// );

router.post(
  "/checkout/stripe-session",
  authenticateToken,
  stripeSession
);

router.get('/orders', getOrders);

// Get single order with relations
router.get('/orders/:id',  getOrderById);

// Update status
router.patch('/orders/:id/status',  updateStatus);

// Bulk cancel
router.post('/orders/bulk-cancel',  bulkCancel);

// Tracking update webhook (called by Fishbowl or Admin to mark Shipped & email customer)
router.post('/orders/webhook/tracking', updateOrderTracking);
router.patch('/orders/:id/tracking', updateOrderTracking);
router.post('/orders/:id/tracking', updateOrderTracking);


module.exports = router;
