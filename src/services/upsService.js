const axios = require('axios');

class UpsService {
  constructor() {
    this.token = null;
    this.tokenExpiry = null;
  }

  getEnvironment() {
    const env = (process.env.UPS_ENVIRONMENT || 'production').toLowerCase();
    return env === 'production'
      ? 'https://onlinetools.ups.com'
      : 'https://wwwcie.ups.com';
  }

  getShipperDetails() {
    return {
      accountNumber: process.env.UPS_ACCOUNT_NUMBER || '80E8E8',
      name: process.env.UPS_SHIPPER_NAME || 'Club Pro MFG',
      address: process.env.UPS_SHIPPER_ADDRESS || '123 Test Street',
      city: process.env.UPS_SHIPPER_CITY || 'Tampa',
      state: process.env.UPS_SHIPPER_STATE || 'FL',
      zip: process.env.UPS_SHIPPER_ZIP || '33619',
      country: process.env.UPS_SHIPPER_COUNTRY || 'US',
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 1. OAuth 2.0 Token Generation (with auto-caching)
  // ─────────────────────────────────────────────────────────────
  async getAccessToken() {
    const clientId = process.env.UPS_CLIENT_ID;
    const clientSecret = process.env.UPS_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('UPS_CLIENT_ID or UPS_CLIENT_SECRET is missing in environment variables.');
    }

    // Return cached token if still valid (with 60-second buffer)
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry - 60000) {
      return this.token;
    }

    const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const baseUrl = this.getEnvironment();

    try {
      const response = await axios.post(
        `${baseUrl}/security/v1/oauth/token`,
        'grant_type=client_credentials',
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${authHeader}`,
          },
          timeout: 10000,
        }
      );

      this.token = response.data.access_token;
      // expires_in is in seconds
      const expiresInSec = Number(response.data.expires_in) || 14400;
      this.tokenExpiry = Date.now() + expiresInSec * 1000;

      console.log('[UPS Service] Successfully acquired OAuth 2.0 access token');
      return this.token;
    } catch (err) {
      const errMsg = err.response?.data?.response?.errors?.[0]?.message || err.response?.data || err.message;
      console.error('[UPS Service] OAuth failed:', errMsg);
      throw new Error(`UPS Authentication failed: ${JSON.stringify(errMsg)}`);
    }
  }

  // Map service codes to readable names
  getServiceName(code) {
    const map = {
      '03': 'UPS Ground',
      '01': 'UPS Next Day Air',
      '02': 'UPS 2nd Day Air',
      '12': 'UPS 3 Day Select',
      '13': 'UPS Next Day Air Saver',
      '14': 'UPS Next Day Air Early',
      '59': 'UPS 2nd Day Air A.M.',
      '65': 'UPS Worldwide Saver',
      '07': 'UPS Worldwide Express',
      '08': 'UPS Worldwide Expedited',
      '11': 'UPS Standard',
    };
    return map[code] || `UPS Service (${code})`;
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Fetch Live Rating (Shop all available rates)
  // ─────────────────────────────────────────────────────────────
  async getLiveRates({ toAddress, packages = [] }) {
    const shipper = this.getShipperDetails();
    const token = await this.getAccessToken();
    const baseUrl = this.getEnvironment();

    // Prepare package definitions
    const upsPackages = packages.map((pkg) => {
      const weight = Math.max(0.5, parseFloat(pkg.weight || 1));
      const length = Math.max(1, parseFloat(pkg.length || 6));
      const width = Math.max(1, parseFloat(pkg.width || 6));
      const height = Math.max(1, parseFloat(pkg.height || 6));

      return {
        PackagingType: {
          Code: '02',
          Description: 'Customer Supplied Package',
        },
        Dimensions: {
          UnitOfMeasurement: { Code: 'IN', Description: 'Inches' },
          Length: length.toFixed(1),
          Width: width.toFixed(1),
          Height: height.toFixed(1),
        },
        PackageWeight: {
          UnitOfMeasurement: { Code: 'LBS', Description: 'Pounds' },
          Weight: weight.toFixed(1),
        },
      };
    });

    const isResidential = toAddress.isResidential !== false;

    const requestBody = {
      RateRequest: {
        Request: {
          TransactionReference: {
            CustomerContext: 'ClubPro Live Rate Calculation',
          },
        },
        Shipment: {
          Shipper: {
            Name: shipper.name,
            ShipperNumber: shipper.accountNumber,
            Address: {
              AddressLine: [shipper.address],
              City: shipper.city,
              StateProvinceCode: shipper.state,
              PostalCode: shipper.zip,
              CountryCode: shipper.country,
            },
          },
          ShipTo: {
            Name: toAddress.fullName || 'Customer',
            Address: {
              AddressLine: [toAddress.address1 || '123 Main St'],
              City: toAddress.city || '',
              StateProvinceCode: toAddress.state || '',
              PostalCode: toAddress.zip || '',
              CountryCode: toAddress.country || 'US',
              ResidentialAddressIndicator: isResidential ? 'Y' : 'N',
            },
          },
          ShipFrom: {
            Name: shipper.name,
            Address: {
              AddressLine: [shipper.address],
              City: shipper.city,
              StateProvinceCode: shipper.state,
              PostalCode: shipper.zip,
              CountryCode: shipper.country,
            },
          },
          PaymentDetails: {
            ShipmentCharge: [
              {
                Type: '01',
                BillShipper: {
                  AccountNumber: shipper.accountNumber,
                },
              },
            ],
          },
          ShipmentRatingOptions: {
            NegotiatedRatesIndicator: '',
          },
          Package: upsPackages,
        },
      },
    };

    try {
      const res = await axios.post(
        `${baseUrl}/api/rating/v1/Shop`,
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            transId: `clubpro-${Date.now()}`,
            transactionSrc: 'ClubProMfg',
          },
          timeout: 12000,
        }
      );

      const rawRatedShipments = res.data?.RateResponse?.RatedShipment;
      const ratedShipments = Array.isArray(rawRatedShipments)
        ? rawRatedShipments
        : rawRatedShipments
        ? [rawRatedShipments]
        : [];

      if (ratedShipments.length === 0) {
        throw new Error('No rated shipments returned from UPS');
      }

      // Check for markup percent in env (e.g., 0% or 10%)
      const markupPercent = parseFloat(process.env.SHIPPING_MARKUP_PERCENT || '0');

      const parsedRates = ratedShipments.map((rate) => {
        const serviceCode = rate.Service?.Code;
        const serviceName = this.getServiceName(serviceCode);

        // Prefer negotiated rates if available for this account, else standard total charges
        const baseCharge =
          rate.NegotiatedRateCharges?.TotalCharge?.MonetaryValue ||
          rate.TotalCharges?.MonetaryValue ||
          '0.00';

        let numericCost = parseFloat(baseCharge);
        if (markupPercent > 0) {
          numericCost = numericCost * (1 + markupPercent / 100);
        }

        return {
          carrier: 'UPS',
          serviceCode,
          serviceName,
          cost: Math.round(numericCost * 100) / 100,
          currency: rate.TotalCharges?.CurrencyCode || 'USD',
          guaranteedDays: rate.GuaranteedDelivery?.BusinessDaysInTransit || null,
        };
      });

      // Filter valid positive rates
      const validRates = parsedRates.filter((r) => r.cost > 0);

      if (validRates.length === 0) {
        throw new Error('No valid positive rates found in UPS response');
      }

      // Sort by cost ascending
      validRates.sort((a, b) => a.cost - b.cost);

      // Prefer UPS Ground (code "03") if available, otherwise lowest cost
      const groundRate = validRates.find((r) => r.serviceCode === '03');
      const selectedRate = groundRate || validRates[0];

      return {
        success: true,
        rates: validRates,
        selectedRate,
      };
    } catch (err) {
      const errDetails = err.response?.data?.response?.errors || err.response?.data || err.message;
      console.error('[UPS Service] Rating API Error:', JSON.stringify(errDetails));
      throw err;
    }
  }
}

module.exports = new UpsService();
