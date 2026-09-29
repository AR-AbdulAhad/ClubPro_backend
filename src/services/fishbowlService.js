const axios = require('axios');

class FishbowlService {
  constructor() {
    this.baseURL = process.env.FISHBOWL_API_URL;
    this.token = null;
  }

  async login() {
    if (this.token) return this.token;
    try {
      const response = await axios.post(
        `${this.baseURL}/api/login`,
        {
          appName: 'ClubProEcom',
          appDescription: 'E-commerce Integration with Prisma',
          appId: 45821,
          username: process.env.FISHBOWL_USERNAME,
          password: process.env.FISHBOWL_PASSWORD,
        },
        { timeout: 8000 }
      );

      if (!response.data?.token) {
        throw new Error('No token received from Fishbowl');
      }

      this.token = response.data.token;
      console.log('[Fishbowl] Login successful');
      return this.token;
    } catch (err) {
      console.error('[Fishbowl] Login failed:', err.response?.data || err.message);
      throw new Error('Fishbowl authentication failed');
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
      timeout: 10000,
    };

    try {
      const res = await axios(config);
      return res.data;
    } catch (err) {
      if (err.response?.status === 401) {
        console.log('[Fishbowl] Token expired, re-logging in...');
        this.token = null;
        return this.request(method, endpoint, data, customHeaders);
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

  // Import Part (Inventory Item)
  async importPart(csvString) {
    return this.request('POST', '/api/import/Part', csvString, {
      contentType: 'text/plain',
    });
  }

  // Import Product (Sellable Item mapped to Part)
  async importProduct(csvString) {
    return this.request('POST', '/api/import/Product', csvString, {
      contentType: 'text/plain',
    });
  }

  // Sync / Create Product in Fishbowl (creates both Part and Product)
  async syncProduct(product) {
    try {
      const partNumber = product.sku?.trim() || `PART-${product.id}`;
      const name = (product.name || '').replace(/"/g, '""');
      const description = (product.description || name).replace(/"/g, '""');
      const price = product.regularPrice ? Number(product.regularPrice).toFixed(2) : '0.00';
      const weight = product.weightLb ? Number(product.weightLb).toFixed(2) : '0';
      const length = product.lengthIn ? Number(product.lengthIn).toFixed(2) : '0';
      const width = product.widthIn ? Number(product.widthIn).toFixed(2) : '0';
      const height = product.heightIn ? Number(product.heightIn).toFixed(2) : '0';

      // 1. Create/Update Part (Inventory Item)
      const partHeader = `"PartNumber","PartDescription","PartDetails","UOM","PartType","Active","POItemType","Weight","WeightUOM","Width","WidthUOM","Height","HeightUOM","Length","LengthUOM","Price"`;
      const partRow = `"${partNumber}","${name}","${description}","ea","Inventory","true","Purchase","${weight}","lbs","${width}","in","${height}","in","${length}","in","${price}"`;
      const partCsv = `${partHeader}\n${partRow}`;
      
      console.log(`[Fishbowl] Syncing Part for product ID ${product.id} ("${partNumber}")...`);
      const result = await this.importPart(partCsv);
      console.log(`[Fishbowl] Successfully synced Part "${partNumber}"`);

      // 2. Create/Update Product (Sellable Item linked to Part)
      try {
        const productHeader = `"PartNumber","ProductNumber","ProductDescription","Price","UOM","Active"`;
        const productRow = `"${partNumber}","${partNumber}","${name}","${price}","ea","true"`;
        const productCsv = `${productHeader}\n${productRow}`;
        
        console.log(`[Fishbowl] Syncing Product mapping for "${partNumber}"...`);
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

  // Deactivate Part & Product in Fishbowl when deleted from dashboard
  async deactivateProduct(partNumber) {
    if (!partNumber) return;
    try {
      console.log(`[Fishbowl] Deactivating Part & Product "${partNumber}"...`);
      // 1. Deactivate Part
      const partCsv = `"PartNumber","PartDescription","UOM","PartType","Active"\n"${partNumber}","${partNumber}","ea","Inventory","false"`;
      await this.importPart(partCsv);

      // 2. Deactivate Product mapping
      try {
        const prodCsv = `"PartNumber","ProductNumber","Active"\n"${partNumber}","${partNumber}","false"`;
        await this.importProduct(prodCsv);
      } catch (e) {}

      console.log(`[Fishbowl] Successfully deactivated "${partNumber}" in Fishbowl`);
    } catch (err) {
      console.error(`[Fishbowl Deactivate Warning] Failed to deactivate "${partNumber}":`, err.response?.data?.message || err.message);
    }
  }

  // Import Customer
  async importCustomer(csvString) {
    return this.request('POST', '/api/import/Customer', csvString, {
      contentType: 'text/plain',
    });
  }

  // Import Sales Order
  async importSalesOrder(csvString) {
    return this.request('POST', '/api/import/Sales-Order', csvString, {
      contentType: 'text/plain',
    });
  }

  // Get current inventory quantity for a part
  async getPartInventory(partNumber) {
    const res = await this.request('GET', `/api/parts/inventory?number=${encodeURIComponent(partNumber)}`);
    return Number(res?.results?.[0]?.quantity || 0);
  }
}

module.exports = new FishbowlService();