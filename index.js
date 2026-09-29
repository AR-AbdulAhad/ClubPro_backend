const express = require("express");
const cors = require("cors");
require("dotenv").config();


const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const app = express();

app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  require('./src/controllers/orderController').stripeWebhook
);

// const bodyParser = require("body-parser");

const authRoutes = require("./src/routes/authRoutes");

const productRoutes = require("./src/routes/productRoutes");
const authCustomer = require("./src/routes/authCustomer");
const organizationSettingsRoutes = require("./src/routes/organizationSettingsRoutes");
const dealerRegistrationRoutes = require("./src/routes/dealerRegistrationRoutes");
const adminRoutes = require("./src/routes/adminRoutes");
const notificationRoutes = require("./src/routes/notificationRoutes");
const rolesRoutes = require("./src/routes/rolesRoutes");
const modelRoutes = require("./src/routes/modelRoutes");
const brandRoutes = require("./src/routes/brandRoutes");
const productTypeRoutes = require("./src/routes/productTypeRoutes");
const customerRoutes = require("./src/routes/customerRoutes");
const orderRoutes = require("./src/routes/orderRoutes");
// const stripeRoutes = require("./src/routes/stripeRoute");
const profileRoutes = require("./src/routes/profileRoutes");
const contactRoutes = require("./src/routes/contactRoutes");
// const checkoutRoutes = require("./src/routes/checkoutRoutes");
const warrantyRoutes = require("./src/routes/warrantyRoutes");
const statsRoutes = require("./src/routes/statsRoutes");
const seoRoutes = require("./src/routes/seoRoutes");
const heroSectionRoutes = require("./src/routes/heroSectoinRoutes");
const dimeRoutes = require("./src/routes/dimeRoutes");





// app.use("/api", stripeRoutes);


const PORT = process.env.PORT || 5000;

// ---------- CORS: Read URLs from .env ----------
const rawOrigins = process.env.FRONTEND_URLS;

if (!rawOrigins) {
  console.error("ERROR: FRONTEND_URLS missing in .env");
  process.exit(1);
}

const allowedOrigins = rawOrigins
  .split(",")
  .map((url) => url.trim())
  .filter((url) => url.length > 0);

if (allowedOrigins.length === 0) {
  console.error("ERROR: No valid URLs in FRONTEND_URLS");
  process.exit(1);
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`BLOCKED: ${origin}`);
      callback(new Error("CORS: Not allowed"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors()); // This enables CORS with default settings (allows all origins)app.use(express.json());
app.use(express.json({ limit: "20mb" }));
app.get("/", (req, res) => {
  res.status(200).json({ status: "success", message: "Server is running!!" });
});

const path = require("path");
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/api", authRoutes);
app.use("/api", productRoutes);
app.use("/api", rolesRoutes);
app.use("/api", authCustomer);
app.use("/api", organizationSettingsRoutes);
app.use("/api", adminRoutes);
app.use("/api", notificationRoutes);
app.use("/api", dealerRegistrationRoutes);
app.use("/api", modelRoutes);
app.use("/api", brandRoutes);
app.use("/api", productTypeRoutes);
app.use("/api", customerRoutes);
app.use("/api", profileRoutes);
app.use("/api", contactRoutes);
app.use("/api", statsRoutes);
app.use("/api/seo", seoRoutes);
app.use("/api", heroSectionRoutes);
// app.use("/api", checkoutRoutes);


app.use("/api", orderRoutes);
app.use("/api", warrantyRoutes);
app.use("/api", dimeRoutes);





app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("Shutting down server...");
  process.exit(0);
});
