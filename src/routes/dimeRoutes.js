const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middlewares/authMiddleware");
const { getGatewayConfig, dimeCharge } = require("../controllers/dimeController");

// Public: frontend calls this to know which gateway to show
router.get("/payment/gateway-config", getGatewayConfig);

// Protected: process Dime/NMI payment
router.post("/payment/dime-charge", authenticateToken, dimeCharge);

module.exports = router;
