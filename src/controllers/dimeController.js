const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const querystring = require("querystring");
const { sendClubProOrderWebhook } = require("../utils/clubProWebhook");

const prisma = new PrismaClient();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function splitName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

// ─── GET: which gateway is active ──────────────────────────────────────────────
// GET /api/payment/gateway-config
// Returns { gateway: "stripe" | "dime", tokenizationKey?: string }
exports.getGatewayConfig = (req, res) => {
  const stripeEnabled = process.env.STRIPE_ENABLED === "true";
  if (stripeEnabled) {
    return res.json({ gateway: "stripe" });
  }
  // Return public tokenization key for Collect.js — never the private security_key
  return res.json({
    gateway: "dime",
    tokenizationKey: process.env.DIME_TOKENIZATION_KEY,
    gatewayUrl: process.env.DIME_GATEWAY_URL || "https://dime.transactiongateway.com",
  });
};

// ─── POST: Process Dime/NMI payment ────────────────────────────────────────────
// POST /api/payment/dime-charge
// Body: { payment_token, amount, items, shippingAddress, billingAddress }
exports.dimeCharge = async (req, res) => {
  try {
    const {
      payment_token,  // from Collect.js frontend tokenization
      amount,         // total amount string e.g. "49.99"
      items,          // [{ id, qty, price, name }]
      shippingAddress = {},
      billingAddress  = {},
    } = req.body;

    const customerId = req.user.id;

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!payment_token || !amount || !items?.length) {
      return res.status(400).json({
        success: false,
        message: "Missing payment_token, amount, or items",
      });
    }

    const parsedItems = items.map((item) => ({
      ...item,
      qty: Math.max(1, Number(item.qty || item.quantity || 1)),
    }));

    // ── Customer lookup ───────────────────────────────────────────────────────
    const customer = await prisma.customers.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    // ── Stock check ───────────────────────────────────────────────────────────
    const productIds = parsedItems.map((i) => Number(i.id));
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    for (const item of parsedItems) {
      const product = products.find((p) => p.id === Number(item.id));
      if (!product) {
        return res.status(400).json({ success: false, message: `Product ${item.id} not found` });
      }
      if (product.stock < item.qty) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for "${product.name}"`,
        });
      }
    }

    // ── Charge via NMI transact.php ───────────────────────────────────────────
    const nmiEndpoint =
      (process.env.DIME_GATEWAY_URL || "https://dime.transactiongateway.com") +
      "/api/transact.php";

    const postData = querystring.stringify({
      security_key:  process.env.DIME_SECURITY_KEY,
      type:          "sale",
      payment_token, // tokenized card data from Collect.js
      amount:        parseFloat(amount).toFixed(2),
      // billing
      first_name:    billingAddress.firstName || customer.fullName?.split(" ")[0] || "",
      last_name:     billingAddress.lastName  || customer.fullName?.split(" ").slice(1).join(" ") || "",
      address1:      billingAddress.address1  || customer.billingStreet    || "",
      city:          billingAddress.city      || customer.billingCity      || "",
      state:         billingAddress.state     || customer.billingState     || "",
      zip:           billingAddress.zip       || customer.billingZip       || "",
      country:       billingAddress.country   || customer.billingCountry   || "US",
      email:         customer.email,
      phone:         customer.phone           || "",
      // order description
      order_description: `ClubPro Order - ${parsedItems.length} item(s)`,
    });

    let nmiResponse;
    try {
      const nmiResult = await axios.post(nmiEndpoint, postData, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 30000,
      });
      // NMI returns query-string style: "response=1&responsetext=SUCCESS&transactionid=123"
      nmiResponse = querystring.parse(nmiResult.data);
    } catch (nmiErr) {
      console.error("NMI API call failed:", nmiErr.message);
      return res.status(502).json({
        success: false,
        message: "Payment gateway unreachable. Please try again.",
      });
    }

    console.log("NMI response:", nmiResponse);

    // response=1 means Approved
    if (nmiResponse.response !== "1") {
      return res.status(400).json({
        success: false,
        message: nmiResponse.responsetext || "Payment declined",
        code:    nmiResponse.response_code,
      });
    }

    const transactionId = nmiResponse.transactionid;

    // ── Create order + decrement stock (same as Stripe webhook) ───────────────
    const { firstName: shipFirstName, lastName: shipLastName } = splitName(
      shippingAddress.fullName || customer.fullName
    );

    const shipAddr = shippingAddress;
    const subtotal = parsedItems.reduce(
      (acc, item) => acc + Number(item.price) * item.qty,
      0
    );
    const shippingCost = parseFloat(shippingAddress.shippingCost || 0);

    let order;
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Create order
        order = await tx.order.create({
          data: {
            customerId,
            status:         "PAID",
            totalAmount:    parseFloat(amount),
            shipmentCost:   shippingCost,
            shipmentStatus: "UNKNOWN",
            shipFirstName,
            shipLastName,
            shipAddress1:   shipAddr.address1 || customer.commercialStreet || null,
            shipAddress2:   shipAddr.address2 || null,
            shipCity:       shipAddr.city     || customer.commercialCity    || null,
            shipState:      shipAddr.state    || customer.commercialState   || null,
            shipZip:        shipAddr.zip      || customer.commercialZip     || null,
            shipCountry:    shipAddr.country  || customer.commercialCountry || null,
            shipEmail:      customer.email,
            shipPhone:      customer.phone    || null,
            items: {
              create: parsedItems.map((item) => ({
                productId:    Number(item.id),
                quantity:     item.qty,
                priceAtOrder: Number(item.price),
              })),
            },
          },
          include: { items: true },
        });

        console.log("Dime order created in DB:", order.id, "| txn:", transactionId);

        // 2. Send ClubPro WMS Webhook
        try {
          const orderProducts = await tx.product.findMany({
            where: { id: { in: parsedItems.map((i) => Number(i.id)) } },
          });
          await sendClubProOrderWebhook({
            order: {
              order_number: String(order.id),
              order_date:   order.createdAt.toISOString(),
              currency:     "USD",
              subtotal:     subtotal.toFixed(2),
              total_tax:    "0.00",
              total_shipping: shippingCost.toFixed(2),
              total_price:  parseFloat(amount).toFixed(2),
            },
            shipping_address: {
              first_name: shipFirstName,
              last_name:  shipLastName,
              company:    null,
              address1:   shipAddr.address1 || customer.commercialStreet || null,
              address2:   shipAddr.address2 || null,
              city:       shipAddr.city     || customer.commercialCity    || null,
              state:      shipAddr.state    || customer.commercialState   || null,
              zip:        shipAddr.zip      || customer.commercialZip     || null,
              country:    shipAddr.country  || customer.commercialCountry || null,
              email:      customer.email,
              phone:      customer.phone    || null,
            },
            billing_address: {
              first_name: billingAddress.firstName || shipFirstName,
              last_name:  billingAddress.lastName  || shipLastName,
              company:    null,
              address1:   billingAddress.address1  || customer.billingStreet    || null,
              address2:   billingAddress.address2  || null,
              city:       billingAddress.city      || customer.billingCity      || null,
              state:      billingAddress.state     || customer.billingState     || null,
              zip:        billingAddress.zip       || customer.billingZip       || null,
              country:    billingAddress.country   || customer.billingCountry   || null,
            },
            line_items: parsedItems.map((item) => {
              const product = orderProducts.find((p) => p.id === Number(item.id));
              return {
                sku:      product?.sku || "",
                quantity: item.qty,
                price:    Number(item.price).toFixed(2),
              };
            }),
          });
        } catch (clubProErr) {
          console.error("ClubPro webhook failed (Dime order):", clubProErr);
          // Non-fatal — order already created
        }

        // 3. Decrement stock
        for (const item of parsedItems) {
          await tx.product.update({
            where: { id: Number(item.id) },
            data:  { stock: { decrement: item.qty } },
          });
        }
      }, { timeout: 30000 });
    } catch (dbErr) {
      console.error("Order creation failed after successful Dime payment:", dbErr);
      // Payment succeeded but DB failed — log for manual recovery
      console.error("MANUAL RECOVERY NEEDED — Dime txn:", transactionId, "| customer:", customerId);
      return res.status(500).json({
        success: false,
        message: "Payment succeeded but order creation failed. Please contact support.",
        transactionId,
      });
    }

    return res.json({
      success: true,
      transactionId,
      orderId: order.id,
      message: "Payment successful",
    });

  } catch (err) {
    console.error("dimeCharge unexpected error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
