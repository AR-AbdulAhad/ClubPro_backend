const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const { validationResult } = require("express-validator");
const nodemailer = require("nodemailer");
const { sendEmail } = require("../utils/sendEmail");
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Services
const fishbowl = require("../services/fishbowlService");
const shippingService = require("../services/shippingService");

const prisma = new PrismaClient();

// Fishbowl Service disabled per user request
// const fishbowl = require('../services/fishbowlService');

// ClubPro (Larimar Logistics WMS) order webhook
const { sendClubProOrderWebhook } = require('../utils/clubProWebhook');

// Splits a Stripe "name" field ("Jon Doe") into { firstName, lastName }
function splitName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

// Email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

// ────────────────────────────────────────────────
// Stripe Webhook - Payment Complete → Order + Middleware Webhook Sync
// ────────────────────────────────────────────────
exports.stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send("Webhook Error");
  }

  console.log("\n========== [WEBHOOK] Stripe event received ==========");
  console.log("Event type:", event.type);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const rawItems = JSON.parse(session.metadata.items || "[]");
    const items = rawItems.map((item) => ({
      ...item,
      qty: Math.max(1, Number(item.qty || item.quantity || item.count || 1)),
    }));
    const shippingCost = parseFloat(session.metadata.shippingCost || "0");
    const serviceLevel = session.metadata.serviceLevel || "";
    const serviceName = session.metadata.serviceName || "";

    console.log("Session amount_total:", session.amount_total, "| currency:", session.currency);
    console.log("Session customer_details (name/email/address entered on Stripe hosted page):", JSON.stringify(session.customer_details, null, 2));
    console.log("Session shipping_details:", JSON.stringify(session.shipping_details, null, 2));
    console.log("Parsed items from metadata:", JSON.stringify(items, null, 2));
    console.log("Shipping cost:", shippingCost, "| serviceLevel:", serviceLevel, "| serviceName:", serviceName);

    let shipMeta = {};
    try {
      if (session.metadata?.shippingAddress) shipMeta = JSON.parse(session.metadata.shippingAddress);
    } catch {}

    // Prefer the shipping address entered on Checkout page / metadata; fall back to Stripe details & customer profile
    const shipSource = session.shipping_details || session.customer_details || {};
    const shipAddr = shipSource.address || {};

    // customer_details is what Stripe collected via billing_address_collection: "required"
    const billSource = session.customer_details || {};
    const billAddr = billSource.address || {};
    const { firstName: billFirstName, lastName: billLastName } = splitName(billSource.name);

    try {
      await prisma.$transaction(async (tx) => {
        const customer = await tx.customers.findUnique({
          where: { id: Number(session.metadata.customerId) },
        });

        if (!customer) {
          throw new Error("Customer not found");
        }

        const { firstName: shipFirstName, lastName: shipLastName } = splitName(
          shipMeta.fullName || shipSource.name || customer.fullName
        );

        const shipAddress1 = shipMeta.address1 || shipAddr.line1 || customer.commercialStreet || customer.billingStreet || null;
        const shipAddress2 = shipMeta.address2 || shipAddr.line2 || null;
        const shipCity     = shipMeta.city     || shipAddr.city || customer.commercialCity || customer.billingCity || null;
        const shipState    = shipMeta.state    || shipAddr.state || customer.commercialState || customer.billingState || null;
        const shipZip      = shipMeta.zip      || shipAddr.postal_code || customer.commercialZip || customer.billingZip || null;
        const shipCountry  = shipMeta.country  || shipAddr.country || customer.commercialCountry || customer.billingCountry || null;
        const shipPhone    = shipMeta.phone    || session.customer_details?.phone || customer.phone || null;

        // 1. Create order in Prisma (so it immediately displays in Admin Dashboard)
        const order = await tx.order.create({
          data: {
            customerId: Number(session.metadata.customerId),
            status: "PAID",
            totalAmount: session.amount_total / 100,
            shipmentCost: shippingCost,
            shipmentStatus: "UNKNOWN",
            shipFirstName,
            shipLastName,
            shipAddress1,
            shipAddress2,
            shipCity,
            shipState,
            shipZip,
            shipCountry,
            shipEmail: session.customer_details?.email || customer.email,
            shipPhone,
            items: {
              create: items.map((item) => ({
                productId: item.id,
                quantity: item.qty,
                priceAtOrder: Number(item.price),
              })),
            },
          },
          include: { items: true },
        });

        console.log("Order created in DB (Visible in Admin Dashboard):", JSON.stringify(order, null, 2));

        // 2. Send Middleware (ClubPro WMS) Webhook right after order creation
        try {
          const orderProducts = await tx.product.findMany({
            where: { id: { in: items.map((i) => i.id) } },
          });

          const subtotal = items.reduce(
            (acc, item) => acc + Number(item.price) * item.qty,
            0
          );
          const totalTax = (session.total_details?.amount_tax || 0) / 100;

          await sendClubProOrderWebhook({
            order: {
              order_number: String(order.id),
              order_date: order.createdAt.toISOString(),
              currency: (session.currency || "usd").toUpperCase(),
              subtotal: subtotal.toFixed(2),
              total_tax: totalTax.toFixed(2),
              total_shipping: shippingCost.toFixed(2),
              total_price: (session.amount_total / 100).toFixed(2),
            },
            shipping_address: {
              first_name: shipFirstName || null,
              last_name: shipLastName || null,
              company: null,
              address1: shipAddr.line1 || null,
              address2: shipAddr.line2 || null,
              city: shipAddr.city || null,
              state: shipAddr.state || null,
              zip: shipAddr.postal_code || null,
              country: shipAddr.country || null,
              email: session.customer_details?.email || null,
              phone: session.customer_details?.phone || null,
            },
            billing_address: {
              first_name: billFirstName || null,
              last_name: billLastName || null,
              company: null,
              address1: billAddr.line1 || null,
              address2: billAddr.line2 || null,
              city: billAddr.city || null,
              state: billAddr.state || null,
              zip: billAddr.postal_code || null,
              country: billAddr.country || null,
            },
            line_items: items.map((item) => {
              const product = orderProducts.find((p) => p.id === item.id);
              return {
                sku: product?.sku || "",
                quantity: item.qty,
                price: Number(item.price).toFixed(2),
              };
            }),
          });
        } catch (clubProErr) {
          console.error("ClubPro middleware webhook failed:", clubProErr);
        }

        // 3. Decrease stock in Prisma (consolidating quantities by product)
        const requestedQtyByProduct = {};
        for (const item of items) {
          const pId = Number(item.id);
          requestedQtyByProduct[pId] = (requestedQtyByProduct[pId] || 0) + item.qty;
        }

        for (const [pIdStr, totalQty] of Object.entries(requestedQtyByProduct)) {
          const pId = Number(pIdStr);
          const product = await tx.product.findUnique({
            where: { id: pId },
          });

          if (!product) throw new Error(`Product ID ${pId} not found`);
          if (product.stock < totalQty) {
            throw new Error(`Insufficient stock for ${product.name}. Available: ${product.stock}, Requested: ${totalQty}`);
          }

          await tx.product.update({
            where: { id: pId },
            data: { stock: { decrement: totalQty } },
          });
        }

        // 4. Fishbowl Sync: Create Sales Order for FedEx Ship Manager & WorldShip
        try {
          await fishbowl.syncSalesOrder({
            order,
            customer,
            items,
            shippingAddress: shipMeta,
            billingAddress: billAddr,
          });
        } catch (fbErr) {
          console.error("Fishbowl order sync failed:", fbErr.message);
        }
      }, { timeout: 30000 }); // Increased timeout for Fishbowl API calls
    } catch (err) {
      console.error("Critical error in webhook processing:", err);
    }
  }

  console.log("========== [WEBHOOK] End ==========\n");
  res.json({ received: true });
};

// ────────────────────────────────────────────────
// Stripe Checkout Session
// ────────────────────────────────────────────────
exports.stripeSession = async (req, res) => {
  try {
    console.log("\n========== [CHECKOUT] Incoming request ==========");
    console.log("Headers:", {
      "content-type": req.headers["content-type"],
      authorization: req.headers.authorization ? "Bearer ***" : undefined,
    });
    console.log("Raw body (req.body):", JSON.stringify(req.body, null, 2));

    if (!req.body || !req.body.items) {
      return res.status(400).json({ message: "Missing or invalid items" });
    }

    const { items: rawItems, shippingAddress = {}, billingAddress = {} } = req.body;
    const items = rawItems.map((item) => ({
      ...item,
      qty: Math.max(1, Number(item.qty || item.quantity || item.count || 1)),
    }));
    const customerId = req.user.id;

    const customer = await prisma.customers.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    console.log("Customer record (from DB, used for billing/shipping):", JSON.stringify(customer, null, 2));

    const itemIds = items.map((i) => Number(i.id));

    const products = await prisma.product.findMany({
      where: { id: { in: itemIds } },
    });

    if (products.length !== items.length) {
      return res.status(400).json({ message: "One or more products not found" });
    }

    // ─── Stock Check (DB stock) ───
    for (const item of items) {
      const product = products.find((p) => p.id === Number(item.id));
      if (product.stock < item.qty) {
        return res.status(400).json({
          message: `Insufficient stock for "${product.name}"`,
        });
      }
    }

    // ─── Unified Rate Calculation (UPS Live Rates for US, Larimar for Int'l) ───
    let shippingCost = 0;
    let selectedRate = null;

    try {
      const rateResult = await shippingService.calculateRate({
        items,
        shippingAddress: {
          fullName: shippingAddress.fullName || customer.fullName || "Customer",
          address1: shippingAddress.address1 || customer.commercialStreet || customer.billingStreet || "123 Main St",
          address2: shippingAddress.address2 || "",
          city: shippingAddress.city || customer.commercialCity || customer.billingCity || "City",
          state: shippingAddress.state || customer.commercialState || customer.billingState || "CA",
          zip: shippingAddress.zip || customer.commercialZip || customer.billingZip || "90001",
          country: shippingAddress.country || customer.commercialCountry || customer.billingCountry || "US",
          phone: shippingAddress.phone || customer.phone || "",
        },
      });

      if (rateResult && rateResult.cost >= 0) {
        shippingCost = rateResult.cost;
        selectedRate = {
          servicelevel: {
            token: rateResult.serviceCode || (rateResult.isInternational ? "INTL" : "UPS_GROUND"),
            name: rateResult.serviceName || "Standard Shipping",
          },
          amount: shippingCost,
        };
      }
    } catch (rateErr) {
      console.error("Live shipping rate calculation failed:", rateErr.message);
    }

    // Stripe line items
    const line_items = items.map((item) => ({
      price_data: {
        currency: "usd",
        product_data: { name: item.name },
        unit_amount: Math.round(Number(item.price) * 100),
      },
      quantity: item.qty,
    }));

    if (shippingCost > 0 || selectedRate) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: selectedRate ? `Shipping (${selectedRate.servicelevel?.name || 'Flat Rate'})` : "Shipping" },
          unit_amount: Math.round(shippingCost * 100),
        },
        quantity: 1,
      });
    }

    const stripeCustomer = await stripe.customers.create({
      email: customer.email,
      name: shippingAddress.fullName || customer.fullName,
      address: {
        line1: billingAddress.address1 || shippingAddress.address1 || customer.billingStreet || "123 Main St",
        city: billingAddress.city || shippingAddress.city || customer.billingCity || "City",
        state: billingAddress.state || shippingAddress.state || customer.billingState || "CA",
        postal_code: billingAddress.zip || shippingAddress.zip || customer.billingZip || "90001",
        country: billingAddress.country || shippingAddress.country || customer.billingCountry || "US",
      },
      shipping: {
        name: shippingAddress.fullName || customer.fullName,
        address: {
          line1: shippingAddress.address1 || customer.commercialStreet || customer.billingStreet || "123 Main St",
          city: shippingAddress.city || customer.commercialCity || customer.billingCity || "City",
          state: shippingAddress.state || customer.commercialState || customer.billingState || "CA",
          postal_code: shippingAddress.zip || customer.commercialZip || customer.billingZip || "90001",
          country: shippingAddress.country || customer.commercialCountry || customer.billingCountry || "US",
        },
      },
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer: stripeCustomer.id,
      customer_update: { name: "auto", address: "auto", shipping: "auto" },
      billing_address_collection: "required",
      shipping_address_collection: { allowed_countries: ["US", "CA"] },
      phone_number_collection: { enabled: true },
      line_items,
      metadata: {
        customerId: String(customerId),
        items: JSON.stringify(items.map((item) => ({ id: item.id, qty: item.qty, price: item.price }))),
        shippingCost: shippingCost.toString(),
        serviceLevel: selectedRate?.servicelevel?.token || "",
        serviceName: selectedRate?.servicelevel?.name || "Flat Rate",
        shippingAddress: JSON.stringify(shippingAddress),
        billingAddress: JSON.stringify(billingAddress),
      },
      success_url: `https://clubpromfg.com/greengrass/`,
      cancel_url: `https://clubpromfg.com/greengrass/`,
    });

    console.log("Computed shipping cost:", shippingCost, "| selected rate:", selectedRate?.servicelevel?.name || "none");
    console.log("Stripe line_items sent:", JSON.stringify(line_items, null, 2));
    console.log("Stripe session metadata:", JSON.stringify(session.metadata, null, 2));
    console.log("Stripe checkout session URL:", session.url);
    console.log("========== [CHECKOUT] End ==========\n");

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe session creation failed:", err);
    res.status(500).json({ message: "Failed to create Stripe checkout session", error: err.message });
  }
};

// ────────────────────────────────────────────────
// Baaki functions same rahein (getOrders, getOrderById, updateStatus, bulkCancel)
// ────────────────────────────────────────────────
exports.getOrders = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search;
    const status = req.query.status;
    const sort = req.query.sort || "createdAt";
    const order = req.query.order || "desc";

    const where = {
      ...(search && {
        OR: [
          { id: { equals: parseInt(search) || undefined } },
          { customer: { email: { contains: search } } },
          { customer: { fullName: { contains: search } } },
        ],
      }),
      ...(status && { status }),
    };

    const [data, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              fullName: true,
              email: true,
              billingStreet: true,
              billingCity: true,
              billingState: true,
              billingZip: true,
              billingCountry: true,
              commercialStreet: true,
              commercialCity: true,
              commercialState: true,
              commercialZip: true,
              commercialCountry: true,
              isActive: true,
              createdAt: true,
            },
          },
        },
        orderBy: { [sort]: order },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    res.json({
      data,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        limit,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        customer: true,
        items: {
          include: {
            product: {
              include: {
                brand: true,
                model: true,
                productType: true,
              },
            },
          },
        },
      },
    });

    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateStatus = async (req, res) => {
  const { status } = req.body;
  if (!["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"].includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  try {
    const order = await prisma.order.update({
      where: { id: parseInt(req.params.id) },
      data: { status },
    });
    res.json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to update status" });
  }
};

exports.bulkCancel = async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "Invalid ids" });
  }

  try {
    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: { status: "CANCELLED" },
    });
    res.json({ message: "Orders cancelled" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to cancel orders" });
  }
};

// ────────────────────────────────────────────────
// Update Order Tracking & Notify Customer
// POST /api/orders/webhook/tracking
// PATCH /api/orders/:id/tracking
// ────────────────────────────────────────────────
exports.updateOrderTracking = async (req, res) => {
  try {
    const orderIdParam = req.params.id || req.body.orderId || req.body.id || req.body.orderNumber;
    const { trackingNumber, carrier = "UPS", status = "SHIPPED", sendEmailNotification = true } = req.body;

    if (!orderIdParam) {
      return res.status(400).json({ success: false, message: "orderId is required" });
    }

    if (!trackingNumber) {
      return res.status(400).json({ success: false, message: "trackingNumber is required" });
    }

    // Support numeric ID or #ID / Sales Order Number
    const numericId = parseInt(String(orderIdParam).replace(/\D/g, ""), 10);
    const soNumber = String(orderIdParam).startsWith("#") ? String(orderIdParam) : `#${numericId}`;

    const order = await prisma.order.findFirst({
      where: {
        OR: [
          ...(numericId ? [{ id: numericId }] : []),
          { fishbowlSalesOrderNumber: soNumber },
        ],
      },
      include: {
        customer: true,
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: `Order not found with identifier: ${orderIdParam}` });
    }

    // Determine carrier
    let detectedCarrier = carrier || "UPS";
    const cleanTracking = String(trackingNumber).trim();
    if (cleanTracking.toUpperCase().startsWith("1Z")) {
      detectedCarrier = "UPS";
    }

    const trackingUrl = detectedCarrier.toUpperCase() === "FEDEX"
      ? `https://www.fedex.com/fedextrack/?trknbr=${cleanTracking}`
      : `https://www.ups.com/track?tracknum=${cleanTracking}`;

    // Update order in database
    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: status || "SHIPPED",
        shipmentStatus: "SHIPPED",
        trackingNumber: cleanTracking,
        carrier: detectedCarrier,
      },
      include: {
        customer: true,
        items: {
          include: { product: true },
        },
      },
    });

    // Send shipment notification email to customer
    const recipientEmail = order.shipEmail || order.customer?.email;
    const recipientName = order.shipFirstName ? `${order.shipFirstName} ${order.shipLastName || ""}`.trim() : order.customer?.fullName || "Valued Customer";

    if (sendEmailNotification && recipientEmail) {
      const itemsHtml = order.items.map((i) => `
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #333;">${i.product?.name || "Product"}</td>
          <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; text-align: center; color: #666;">${i.quantity}</td>
          <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; text-align: right; font-weight: 600; color: #111;">$${Number(i.priceAtOrder).toFixed(2)}</td>
        </tr>
      `).join("");

      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #eaeaea; border-radius: 12px; overflow: hidden;">
          <div style="background: #111111; padding: 28px 24px; text-align: center;">
            <h1 style="color: #f9c821; margin: 0; font-size: 24px; letter-spacing: 1px; font-weight: 800;">CLUB PRO MFG</h1>
            <p style="color: #ffffff; margin: 6px 0 0; font-size: 13px; text-transform: uppercase; letter-spacing: 2px;">Your Order Has Shipped!</p>
          </div>
          
          <div style="padding: 32px 24px;">
            <p style="font-size: 16px; color: #222; margin-top: 0;">Hi <strong>${recipientName}</strong>,</p>
            <p style="font-size: 14px; color: #555; line-height: 1.6;">
              Great news! Your order <strong>#${order.id}</strong> has been shipped via <strong>${detectedCarrier}</strong>.
            </p>

            <div style="background: #fbfbfb; border: 1px solid #eee; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
              <div style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Tracking Number</div>
              <div style="font-size: 18px; font-weight: 700; color: #111; font-family: monospace; letter-spacing: 1px; margin-bottom: 16px;">
                ${cleanTracking}
              </div>
              <a href="${trackingUrl}" target="_blank" style="display: inline-block; background: #f9c821; color: #111; font-weight: 700; font-size: 14px; padding: 12px 28px; border-radius: 6px; text-decoration: none; box-shadow: 0 2px 4px rgba(0,0,0,0.08);">
                Track Your Package &rarr;
              </a>
            </div>

            <h3 style="font-size: 15px; color: #111; margin-bottom: 12px; border-bottom: 2px solid #f9c821; padding-bottom: 6px;">Order Summary</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="color: #888; text-transform: uppercase; font-size: 11px;">
                  <th style="text-align: left; padding-bottom: 8px;">Item</th>
                  <th style="text-align: center; padding-bottom: 8px;">Qty</th>
                  <th style="text-align: right; padding-bottom: 8px;">Price</th>
                </tr>
              </thead>
              <tbody>
                ${itemsHtml}
              </tbody>
            </table>

            <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; font-size: 13px; color: #666; line-height: 1.6;">
              <strong>Delivery Address:</strong><br />
              ${order.shipAddress1 || ""}<br />
              ${order.shipCity ? `${order.shipCity}, ` : ""}${order.shipState || ""} ${order.shipZip || ""}<br />
              ${order.shipCountry || "US"}
            </div>
          </div>

          <div style="background: #f7f7f7; padding: 18px 24px; text-align: center; font-size: 12px; color: #888; border-top: 1px solid #eee;">
            Questions? Contact us at <a href="mailto:greengrass@elipsestudio.info" style="color: #111;">greengrass@elipsestudio.info</a>
          </div>
        </div>
      `;

      try {
        await sendEmail({
          to: recipientEmail,
          subject: `Your ClubPro Order #${order.id} Has Shipped! Tracking: ${cleanTracking}`,
          html: emailHtml,
        });
        console.log(`[Order Tracking] Shipment email sent to ${recipientEmail} for order #${order.id}`);
      } catch (mailErr) {
        console.error(`[Order Tracking Warning] Failed to send email to ${recipientEmail}:`, mailErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Order tracking updated and notification email sent.",
      order: updatedOrder,
    });
  } catch (err) {
    console.error("[Order Tracking Error]:", err);
    return res.status(500).json({ success: false, message: "Failed to update tracking", error: err.message });
  }
};