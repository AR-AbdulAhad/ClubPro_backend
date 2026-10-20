const shippingService = require('../services/shippingService');

/**
 * POST /api/shipping/calculate-rate
 * Body: { items: [{ id, qty }], shippingAddress: { zip, state, city, address1, country } }
 */
exports.calculateRate = async (req, res) => {
  try {
    const { items = [], shippingAddress = {} } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cart items are required to calculate shipping.',
      });
    }

    const rateResult = await shippingService.calculateRate({
      items,
      shippingAddress,
    });

    return res.status(200).json({
      success: true,
      shippingCost: rateResult.cost,
      carrier: rateResult.carrier,
      serviceName: rateResult.serviceName,
      isInternational: rateResult.isInternational,
      parcel: rateResult.parcel,
      rates: rateResult.rates || [],
    });
  } catch (err) {
    console.error('[Shipping Controller] Error calculating rate:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to calculate shipping rate.',
      error: err.message,
    });
  }
};
