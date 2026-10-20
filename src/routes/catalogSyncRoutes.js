const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middlewares/authMiddleware");
const { catalogFeed, previewImageSync, applyImageSync } = require("../controllers/catalogSyncController");

router.get("/catalog-sync/feed", catalogFeed);
router.get("/catalog-sync/preview", authenticateToken, previewImageSync);
router.post("/catalog-sync/apply", authenticateToken, applyImageSync);

module.exports = router;
