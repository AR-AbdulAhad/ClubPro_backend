const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

class FishbowlService {
  constructor() {
    this.baseURL = process.env.FISHBOWL_API_URL;
    this.token = null;
    this.tokenExpiry = null;
  }

  isConfigured() {
    return Boolean(
      process.env.FISHBOWL_API_URL &&
      process.env.FISHBOWL_USERNAME &&
      process.env.FISHBOWL_PASSWORD
    );
  }

  async login() {
    if (!this.isConfigured()) {
      throw new Error('Fishbowl credentials or API URL missing in .env');
    }

    if (this.token) return this.token;

    try {
      console.log(`[Fishbowl] Authenticating with ${this.baseURL}...`);
      const response = await axios.post(
        `${this.baseURL}/api/login`,
        {
          appName: 'ClubProEcom',
          appDescription: 'E-commerce Integration with Prisma & WorldShip',
          appId: 45821,
          username: process.env.FISHBOWL_USERNAME,
          password: process.env.FISHBOWL_PASSWORD,
        },
        { timeout: 10000 }
      );

      if (!response.data?.token) {
        throw new Error('No token received from Fishbowl API');
      }

      this.token = response.data.token;
      console.log('[Fishbowl] Login successful');
      return this.token;
    } catch (err) {
      console.error('[Fishbowl] Login failed:', err.response?.data || err.message);
      throw new Error(`Fishbowl authentication failed: ${err.message}`);
    }
  }

  async logout() {
    if (!this.token) return;
    const tokenToLogout = this.token;
    this.token = null;
    try {
      await axios.post(
        `${this.baseURL}/api/logout`,
        {},
        {
          headers: { Authorization: `Bearer ${tokenToLogout}` },
          timeout: 5000,
        }
      );
      console.log('[Fishbowl] Logout successful');
    } catch (err) {
      console.error('[Fishbowl] Logout failed:', err.response?.data || err.message);
    }
  }

  async request(method, endpoint, data = null, customHeaders = {}) {
    if (!this.isConfigured()) {
      console.warn('[Fishbowl Notice] Fishbowl is not configured. Request skipped:', endpoint);
      return null;
    }

    if (!this.token) {
      await this.login();
    }

    const config = {
      method,
      url: `${this.baseURL}${endpoint}`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': customHeaders.contentType || 'application/json',
        ...customHeaders,
      },
      data,
      timeout: 15000,
    };

    try {
      const res = await axios(config);
      return res.data;
    } catch (err) {
      if (err.response?.status === 401 && !customHeaders._isRetry) {
        console.log('[Fishbowl] Token expired, re-logging in...');
        this.token = null;
        return this.request(method, endpoint, data, { ...customHeaders, _isRetry: true });
      }

      console.error('[Fishbowl API Error]', {
        endpoint,
        status: err.response?.status,
        data: err.response?.data,
        message: err.message,
      });

      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Part & Product Sync (Inventory + Sellable Items)
  // ─────────────────────────────────────────────────────────────
  async importPart(csvString) {
    return this.request('POST', '/api/import/Part', csvString, {
      contentType: 'text/plain',
    });
  }

  async importProduct(csvString) {
    return this.request('POST', '/api/import/Product', csvString, {
      contentType: 'text/plain',
    });
  }

  async syncProduct(product) {
    if (!this.isConfigured()) return null;

    try {
      const partNumber = (product.sku?.trim() || product.fishbowlPartNumber?.trim() || `PART-${product.id}`).replace(/"/g, '""');
      const name = (product.name || '').replace(/"/g, '""');
      const description = (product.description || name).replace(/"/g, '""');
      const price = product.regularPrice ? Number(product.regularPrice).toFixed(2) : '0.00';
      const weight = product.weightLb ? Number(product.weightLb).toFixed(2) : '1';
      const length = product.lengthIn ? Number(product.lengthIn).toFixed(2) : '10';
      const width = product.widthIn ? Number(product.widthIn).toFixed(2) : '10';
      const height = product.heightIn ? Number(product.heightIn).toFixed(2) : '5';

      // 1. Create/Update Part
      const partHeader = `"PartNumber","PartDescription","PartDetails","UOM","PartType","Active","POItemType","Weight","WeightUOM","Width","WidthUOM","Height","HeightUOM","Length","LengthUOM","Price"`;
      const partRow = `"${partNumber}","${name}","${description}","ea","Inventory","true","Purchase","${weight}","lbs","${width}","in","${height}","in","${length}","in","${price}"`;
      const partCsv = `${partHeader}\n${partRow}`;

      console.log(`[Fishbowl] Syncing Part for product ID ${product.id} ("${partNumber}")...`);
      const result = await this.importPart(partCsv);
      console.log(`[Fishbowl] Successfully synced Part "${partNumber}"`);

      // 2. Create/Update Product Mapping
      try {
        const productHeader = `"PartNumber","ProductNumber","ProductDescription","Price","UOM","Active"`;
        const productRow = `"${partNumber}","${partNumber}","${name}","${price}","ea","true"`;
        const productCsv = `${productHeader}\n${productRow}`;

        await this.importProduct(productCsv);
        console.log(`[Fishbowl] Successfully synced Product mapping for "${partNumber}"`);
      } catch (prodErr) {
        console.warn(`[Fishbowl Product Mapping Warning]:`, prodErr.response?.data?.message || prodErr.message);
      }

      return { partNumber, result };
    } catch (err) {
      console.error(`[Fishbowl] Error syncing product ID ${product.id}:`, err.response?.data || err.message);
      throw err;
    }
  }

  async deactivateProduct(partNumber) {
    if (!partNumber || !this.isConfigured()) return;
    try {
      console.log(`[Fishbowl] Deactivating Part & Product "${partNumber}"...`);
      const partCsv = `"PartNumber","PartDescription","UOM","PartType","Active"\n"${partNumber}","${partNumber}","ea","Inventory","false"`;
      await this.importPart(partCsv);

      try {
        const prodCsv = `"PartNumber","ProductNumber","Active"\n"${partNumber}","${partNumber}","false"`;
        await this.importProduct(prodCsv);
      } catch (e) {}

      console.log(`[Fishbowl] Successfully deactivated "${partNumber}" in Fishbowl`);
    } catch (err) {
      console.error(`[Fishbowl Deactivate Warning] Failed to deactivate "${partNumber}":`, err.response?.data?.message || err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Customer Import
  // ─────────────────────────────────────────────────────────────
  async importCustomer(csvString) {
    return this.request('POST', '/api/import/Customer', csvString, {
      contentType: 'text/plain',
    });
  }

  async syncCustomer(customer) {
    if (!customer || !this.isConfigured()) return null;

    try {
      const clean = (val) => (val || '').replace(/"/g, '""').trim();
      const name = clean(customer.fullName || 'Valued Customer');
      const email = clean(customer.email);
      const street = clean(customer.billingStreet || customer.commercialStreet || '123 Main St');
      const city = clean(customer.billingCity || customer.commercialCity || 'City');
      const state = clean(customer.billingState || customer.commercialState || 'CA');
      const zip = clean(customer.billingZip || customer.commercialZip || '90001');
      const country = clean(customer.billingCountry || customer.commercialCountry || 'US');

      const custCSV = `"CustomerName","BillingAddress","BillingCity","BillingState","BillingZip","BillingCountry","Email"\n"${name}","${street}","${city}","${state}","${zip}","${country}","${email}"`;

      console.log(`[Fishbowl] Importing/verifying customer: ${name} (${email})`);
      await this.importCustomer(custCSV);

      return email;
    } catch (err) {
      console.error('[Fishbowl] Customer sync failed:', err.response?.data || err.message);
      return customer.email;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Sales Order (SO) Creation for WorldShip & FedEx Ship Manager
  // ─────────────────────────────────────────────────────────────
  async importSalesOrder(csvString) {
    return this.request('POST', '/api/import/Sales-Order', csvString, {
      contentType: 'text/plain',
    });
  }

  /**
   * Generates and imports a complete Sales Order into Fishbowl.
   * Includes Ship-To and Bill-To addresses so FedEx Ship Manager and UPS WorldShip
   * can automatically pull complete shipping data via ODBC.
   */
  async syncSalesOrder({ order, customer, items, shippingAddress = {}, billingAddress = {} }) {
    if (!this.isConfigured()) {
      console.log('[Fishbowl Notice] Fishbowl not configured. Skipping Sales Order creation.');
      return null;
    }

    try {
      console.log(`\n========== [FISHBOWL] Syncing Sales Order for Order #${order.id} ==========`);

      // 1. Ensure customer is synced
      let fbCustomerNum = customer.fishbowlCustomerNumber;
      if (!fbCustomerNum) {
        fbCustomerNum = await this.syncCustomer(customer);
        if (fbCustomerNum) {
          try {
            await prisma.customers.update({
              where: { id: customer.id },
              data: { fishbowlCustomerNumber: fbCustomerNum },
            });
          } catch (e) {}
        }
      }

      const clean = (val) => (val || '').replace(/"/g, '""').trim();
      const soNum = `#${order.id}`;
      const customerName = clean(customer.fullName || 'Valued Customer');
      const dateStr = (order.createdAt ? new Date(order.createdAt) : new Date()).toISOString().split('T')[0];

      // Billing info
      const billToName = clean(billingAddress.firstName ? `${billingAddress.firstName} ${billingAddress.lastName || ''}` : customer.fullName);
      const billToAddress = clean(billingAddress.address1 || customer.billingStreet || customer.commercialStreet || '');
      const billToCity = clean(billingAddress.city || customer.billingCity || customer.commercialCity || '');
      const billToState = clean(billingAddress.state || customer.billingState || customer.commercialState || '');
      const billToZip = clean(billingAddress.zip || customer.billingZip || customer.commercialZip || '');
      const billToCountry = clean(billingAddress.country || customer.billingCountry || customer.commercialCountry || 'US');

      // Shipping info (Crucial for WorldShip / FedEx Ship Manager ODBC)
      const shipToName = clean(shippingAddress.fullName || `${order.shipFirstName || ''} ${order.shipLastName || ''}`.trim() || customer.fullName);
      const shipToAddress = clean(shippingAddress.address1 || order.shipAddress1 || customer.commercialStreet || customer.billingStreet || '');
      const shipToCity = clean(shippingAddress.city || order.shipCity || customer.commercialCity || customer.billingCity || '');
      const shipToState = clean(shippingAddress.state || order.shipState || customer.commercialState || customer.billingState || '');
      const shipToZip = clean(shippingAddress.zip || order.shipZip || customer.commercialZip || customer.billingZip || '');
      const shipToCountry = clean(shippingAddress.country || order.shipCountry || customer.commercialCountry || customer.billingCountry || 'US');

      // CSV Header formatted for Fishbowl Sales Order import
      const header = `"SONum","CustomerName","Date","BillToName","BillToAddress","BillToCity","BillToState","BillToZip","BillToCountry","ShipToName","ShipToAddress","ShipToCity","ShipToState","ShipToZip","ShipToCountry","ItemNumber","ItemDescription","Quantity","Price","UOM"`;

      const rows = [];
      for (const item of items) {
        const product = await prisma.product.findUnique({
          where: { id: Number(item.id || item.productId) },
        });

        if (!product) continue;

        let partNumber = product.fishbowlPartNumber || product.sku;
        if (!partNumber) {
          // Auto-sync product if not yet in Fishbowl
          const syncRes = await this.syncProduct(product);
          partNumber = syncRes?.partNumber || `PART-${product.id}`;
          await prisma.product.update({
            where: { id: product.id },
            data: { fishbowlPartNumber: partNumber },
          });
        }

        const itemName = clean(product.name);
        const qty = item.qty || item.quantity || 1;
        const price = Number(item.price || item.priceAtOrder || product.regularPrice).toFixed(2);

        rows.push(
          `"${soNum}","${customerName}","${dateStr}","${billToName}","${billToAddress}","${billToCity}","${billToState}","${billToZip}","${billToCountry}","${shipToName}","${shipToAddress}","${shipToCity}","${shipToState}","${shipToZip}","${shipToCountry}","${partNumber}","${itemName}","${qty}","${price}","ea"`
        );
      }

      // Add Shipping charge line item (Client SOP: "shipping charge follows with the order from start to finish")
      const shipmentCostNum = parseFloat(order.shipmentCost || 0);
      if (shipmentCostNum > 0) {
        const shipCost = shipmentCostNum.toFixed(2);
        rows.push(
          `"${soNum}","${customerName}","${dateStr}","${billToName}","${billToAddress}","${billToCity}","${billToState}","${billToZip}","${billToCountry}","${shipToName}","${shipToAddress}","${shipToCity}","${shipToState}","${shipToZip}","${shipToCountry}","Shipping","Shipping & Handling","1","${shipCost}","ea"`
        );
      }

      if (rows.length === 0) {
        console.warn('[Fishbowl] No line items found for order:', order.id);
        return null;
      }

      const soCSV = `${header}\n${rows.join('\n')}`;
      console.log(`[Fishbowl] Sending Sales Order CSV to Fishbowl:\n${soCSV}`);

      await this.importSalesOrder(soCSV);

      // Update Order record with Fishbowl SO number
      await prisma.order.update({
        where: { id: order.id },
        data: { fishbowlSalesOrderNumber: soNum },
      });

      console.log(`[Fishbowl] Sales Order ${soNum} successfully created in Fishbowl!`);
      console.log('========== [FISHBOWL] End ==========\n');
      return soNum;
    } catch (err) {
      console.error(`[Fishbowl Order Sync Failed for #${order.id}]:`, err.response?.data || err.message);
      // Non-fatal: does not block order completion
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Test Connectivity Check
  // ─────────────────────────────────────────────────────────────
  async testConnection() {
    try {
      const token = await this.login();
      return {
        success: true,
        message: 'Successfully connected and authenticated with Fishbowl Server.',
        tokenReceived: Boolean(token),
      };
    } catch (err) {
      return {
        success: false,
        message: err.message,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 5. Get Inventory Stock for a Part from Fishbowl
  // ─────────────────────────────────────────────────────────────
  async getPartInventory(partNumber) {
    if (!partNumber || !this.isConfigured()) return null;
    try {
      const res = await this.request('GET', `/api/parts/inventory?number=${encodeURIComponent(partNumber)}`);
      // Fishbowl API returns results array with quantity or on-hand
      const qty = res?.results?.[0]?.quantity ?? res?.quantity ?? res?.qtyOnHand ?? res?.results?.[0]?.qtyOnHand;
      if (qty !== undefined && qty !== null && !isNaN(Number(qty))) {
        return Math.max(0, parseInt(qty, 10));
      }
      return null;
    } catch (err) {
      console.warn(`[Fishbowl Inventory Warning] Could not fetch stock for "${partNumber}":`, err.response?.data || err.message);
      return null;
    }
  }
}

module.exports = new FishbowlService();