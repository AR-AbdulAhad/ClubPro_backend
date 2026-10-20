const { PrismaClient } = require('@prisma/client');
const upsService = require('./upsService');

const prisma = new PrismaClient();

class ShippingService {
  /**
   * Helper: Calculate consolidated parcel weight and dimensions for cart items
   */
  async buildParcel(items = []) {
    let totalWeightLb = 0;
    let maxLengthIn = 5;
    let maxWidthIn = 5;
    let totalHeightIn = 5;

    const productIds = items
      .map((item) => Number(item.id || item.productId))
      .filter((id) => !isNaN(id) && id > 0);

    let dbProducts = [];
    if (productIds.length > 0) {
      try {
        dbProducts = await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            weightLb: true,
            lengthIn: true,
            widthIn: true,
            heightIn: true,
            name: true,
          },
        });
      } catch (err) {
        console.warn('[Shipping Service] Could not fetch product dimensions from DB:', err.message);
      }
    }

    for (const item of items) {
      const pId = Number(item.id || item.productId);
      const dbProduct = dbProducts.find((p) => p.id === pId);
      const qty = Math.max(1, Number(item.qty || item.quantity || 1));

      const weight = parseFloat(item.weightLb || dbProduct?.weightLb || 2.0);
      const length = parseFloat(item.lengthIn || dbProduct?.lengthIn || 10.0);
      const width = parseFloat(item.widthIn || dbProduct?.widthIn || 10.0);
      const height = parseFloat(item.heightIn || dbProduct?.heightIn || 4.0);

      totalWeightLb += weight * qty;
      maxLengthIn = Math.max(maxLengthIn, length);
      maxWidthIn = Math.max(maxWidthIn, width);
      totalHeightIn += height * qty;
    }

    // Safety bounds
    totalWeightLb = Math.max(0.5, totalWeightLb);
    maxLengthIn = Math.max(5, maxLengthIn);
    maxWidthIn = Math.max(5, maxWidthIn);
    totalHeightIn = Math.max(5, Math.min(108, totalHeightIn)); // Max single box constraint

    return {
      weight: parseFloat(totalWeightLb.toFixed(2)),
      length: parseFloat(maxLengthIn.toFixed(2)),
      width: parseFloat(maxWidthIn.toFixed(2)),
      height: parseFloat(totalHeightIn.toFixed(2)),
    };
  }

  /**
   * Domestic fallback rate if carrier API is temporarily unreachable or credentials not yet provided
   */
  calculateDomesticFallback(parcel) {
    const baseRate = parseFloat(process.env.DEFAULT_SHIPPING_BASE_RATE || '12.00');
    const perLb = parseFloat(process.env.DEFAULT_SHIPPING_PER_LB || '1.25');
    const cost = Math.max(baseRate, baseRate + Math.max(0, parcel.weight - 1) * perLb);
    return Math.round(cost * 100) / 100;
  }

  /**
   * International rate calculation (ShipHero / Larimar Logistics partner standard)
   */
  calculateInternationalRate(parcel, countryCode) {
    const baseRate = parseFloat(process.env.INTERNATIONAL_BASE_RATE || '39.00');
    const perLb = parseFloat(process.env.INTERNATIONAL_PER_LB || '3.50');
    const cost = baseRate + Math.max(0, parcel.weight - 1) * perLb;
    return Math.round(cost * 100) / 100;
  }

  /**
   * Unified Rate Calculation:
   * Combines UPS live domestic rates + International rates and presents ONE final rate to the user
   */
  async calculateRate({ items = [], shippingAddress = {} }) {
    const parcel = await this.buildParcel(items);
    const country = (shippingAddress.country || 'US').trim().toUpperCase();
    const isDomestic = country === 'US' || country === 'USA';

    // ─────────────────────────────────────────────────────────────
    // 1. INTERNATIONAL DESTINATIONS (ShipHero / Larimar Logistics)
    // ─────────────────────────────────────────────────────────────
    if (!isDomestic) {
      console.log(`[Shipping Service] Calculating International Rate for country: ${country}`);
      const cost = this.calculateInternationalRate(parcel, country);
      return {
        success: true,
        isInternational: true,
        carrier: 'ShipHero / Larimar International',
        serviceName: 'International Standard Shipping',
        cost,
        parcel,
      };
    }

    // ─────────────────────────────────────────────────────────────
    // 2. DOMESTIC (US) SHIPMENTS — Live UPS API
    // ─────────────────────────────────────────────────────────────
    const hasUpsCredentials = Boolean(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET);

    if (hasUpsCredentials) {
      try {
        console.log('[Shipping Service] Fetching live rates from UPS API...');
        const upsResult = await upsService.getLiveRates({
          toAddress: shippingAddress,
          packages: [parcel],
        });

        if (upsResult.selectedRate) {
          console.log(`[Shipping Service] UPS live rate acquired: $${upsResult.selectedRate.cost} (${upsResult.selectedRate.serviceName})`);
          return {
            success: true,
            isInternational: false,
            carrier: 'UPS',
            serviceName: upsResult.selectedRate.serviceName || 'UPS Ground',
            serviceCode: upsResult.selectedRate.serviceCode || '03',
            cost: upsResult.selectedRate.cost,
            rates: upsResult.rates,
            parcel,
          };
        }
      } catch (upsErr) {
        console.warn('[Shipping Service Warning] UPS Live Rate lookup failed, using fallback:', upsErr.message);
      }
    } else {
      console.log('[Shipping Service Notice] UPS_CLIENT_ID / UPS_CLIENT_SECRET not yet configured, using calibrated fallback rate.');
    }

    // Fallback if UPS is temporarily unreachable or credentials pending
    const fallbackCost = this.calculateDomesticFallback(parcel);
    return {
      success: true,
      isInternational: false,
      carrier: 'UPS',
      serviceName: 'Standard Shipping',
      cost: fallbackCost,
      isFallback: true,
      parcel,
    };
  }
}

module.exports = new ShippingService();
