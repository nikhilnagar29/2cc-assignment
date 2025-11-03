// src/services/persistence.service.js
const db = require('../config/postgres'); // Your pg pool
const redis = require('../config/redis').connection; // Your main redis client

// --- Idempotency ---
const IDEMPOTENCY_EXPIRY_SECONDS = 86400; // 24 hours

/**
 * Checks for idempotency key.
 * @returns {Promise<boolean>} - true if this is a new key, false if it's a duplicate.
 */
async function checkIdempotency(key) {
  try {
    const reply = await redis.set(`idempotency:${key}`, 'processing', 'EX', IDEMPOTENCY_EXPIRY_SECONDS, 'NX');
    return reply === 'OK';
  } catch (err) {
    console.error('Redis checkIdempotency failed:', err);
    // If Redis is down, we must throw an error to stop the order
    throw new Error('Idempotency check failed: ' + err.message);
  }
}

// --- Order Functions ---

/**
 * Saves a new order to Postgres with 'open' status.
 * Returns the full order object.
 */
async function saveNewOrder(orderData) {
  const { client_id, instrument, side, type, price, quantity } = orderData;
  
  const sql = `
    INSERT INTO orders (client_id, instrument, side, type, price, quantity, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'open')
    RETURNING *;
  `;
  
  // Use 'market' orders having NULL price
  const queryParams = [client_id, instrument, side, type, price || null, quantity];
  
  try {
    const { rows } = await db.query(sql, queryParams);
    return rows[0]; // Returns the newly created order
  } catch (err) {
    console.error('Error saving new order:', err);
    throw new Error('Failed to save order to database.');
  }
}

// --- Functions to be called by Matching Engine (NEWLY COMPLETED) ---

/**
 * Saves a new trade to the 'trades' table.
 * @param {object} tradeData - { buy_order_id, sell_order_id, instrument, price, quantity }
 * @returns {Promise<object>} The newly created trade object
 */
async function createTrade(tradeData) {
  const { buy_order_id, sell_order_id, instrument, price, quantity } = tradeData;

  const sql = `
    INSERT INTO trades (buy_order_id, sell_order_id, instrument, price, quantity)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *;
  `;
  const params = [buy_order_id, sell_order_id, instrument, price, quantity];

  try {
    const { rows } = await db.query(sql, params);
    console.log(`Trade created: ${rows[0].trade_id}`);
    return rows[0];
  } catch (err) {
    console.error('Error creating trade:', err);
    // This is a critical error, the engine should be aware
    throw new Error('Failed to save trade to database.');
  }
}

/**
 * Updates an order's status and filled quantity.
 * @param {string} orderId - The UUID of the order to update
 * @param {string} newStatus - The new order_status (e.g., 'partially_filled', 'filled')
 * @param {number} newFilledQuantity - The new total filled quantity
 * @returns {Promise<object>} The updated order object
 */
async function updateOrderStatus(orderId, newStatus, newFilledQuantity) {
  const sql = `
    UPDATE orders
    SET status = $1, filled_quantity = $2, updated_at = NOW()
    WHERE order_id = $3
    RETURNING *;
  `;
  const params = [newStatus, newFilledQuantity, orderId];

  try {
    const { rows } = await db.query(sql, params);
    if (rows.length === 0) {
      throw new Error('Order not found for update.');
    }
    console.log(`Order updated: ${rows[0].order_id} -> Status: ${rows[0].status}`);
    return rows[0];
  } catch (err) {
    console.error(`Error updating order ${orderId}:`, err);
    throw new Error('Failed to update order status.');
  }
}


/**
 * Fetches and formats the order book from Redis.
 * This version calculates totals manually without a 'depth' hash.
 * @param {number} levels - The number of price levels to fetch.
 */
async function getFormattedOrderBook(levels) {
  // 1. Get the top N price levels
  const [askPrices, bidPrices] = await redis.pipeline()
    .zrange('asks:prices', 0, levels - 1)    // Asks: Lowest prices first
    .zrevrange('bids:prices', 0, levels - 1) // Bids: Highest prices first
    .exec();

  const askPriceList = askPrices[1] || [];
  const bidPriceList = bidPrices[1] || [];

  // 2. Build pipeline to get all order IDs from all relevant price LISTs
  const idPipeline = redis.pipeline();
  askPriceList.forEach(price => idPipeline.lrange(`asks:${price}`, 0, -1));
  bidPriceList.forEach(price => idPipeline.lrange(`bids:${price}`, 0, -1));
  
  if (askPriceList.length === 0 && bidPriceList.length === 0) {
    return { asks: [], bids: [] }; // No prices, book is empty
  }

  const idResults = await idPipeline.exec();

  // 3. Extract all order IDs and build pipeline to get their data from the HASH
  let allOrderIds = [];
  const askIdLists = idResults.slice(0, askPriceList.length).map(res => res[1] || []);
  const bidIdLists = idResults.slice(askPriceList.length).map(res => res[1] || []);

  askIdLists.forEach(list => allOrderIds.push(...list));
  bidIdLists.forEach(list => allOrderIds.push(...list));

  const uniqueOrderIds = [...new Set(allOrderIds)];

  if (uniqueOrderIds.length === 0) {
    return { asks: [], bids: [] }; // No orders in the lists, book is empty
  }

  // 4. Get all order details from the 'orders' HASH
  const orderDetailsList = await redis.hmget('orders', ...uniqueOrderIds);

  // 5. Create a simple map (orderId -> quantity) for fast lookup
  const orderQtyMap = new Map();
  orderDetailsList.forEach((json, index) => {
    if (json) {
      try {
        const data = JSON.parse(json);
        orderQtyMap.set(uniqueOrderIds[index], parseFloat(data.quantity) || 0);
      } catch (e) {
        orderQtyMap.set(uniqueOrderIds[index], 0);
      }
    }
  });

  // 6. Format, parse, and calculate cumulative depth
  const formatSide = (priceList, idLists) => {
    let cumulative = 0;
    return priceList.map((price, index) => {
      const orderIds = idLists[index];
      let totalQuantity = 0;
      
      // Sum quantities for all orders at this price level
      orderIds.forEach(id => {
        totalQuantity += orderQtyMap.get(id) || 0;
      });

      cumulative += totalQuantity;
      return {
        price: parseFloat(price),
        quantity: totalQuantity,
        cumulative: cumulative,
      };
    }).filter(level => level.quantity > 0); // Don't show empty levels
  };

  return {
    asks: formatSide(askPriceList, askIdLists),
    bids: formatSide(bidPriceList, bidIdLists),
  };
}


/**
 * Fetches the most recent trades from the 'trades' table.
 * @param {number} limit - The number of trades to fetch.
 * @returns {Promise<Array<object>>} A list of trade objects.
 */
async function getRecentTrades(limit = 50) {
  const sql = `
    SELECT * FROM trades
    ORDER BY "timestamp" DESC
    LIMIT $1;
  `;
  
  try {
    const { rows } = await db.query(sql, [limit]);
    return rows;
  } catch (err) {
    console.error('Error fetching recent trades:', err);
    throw new Error('Failed to fetch trades.');
  }
}

/**
 * Fetches recent trades, joining with the orders table to get client IDs.
 * @param {number} limit - The number of trades to fetch.
 * @returns {Promise<Array<object>>} A list of detailed trade objects.
 */
async function getDetailedTrades(limit = 50) {
  // This SQL query joins the 'trades' table with the 'orders' table *twice*.
  // Once to get the buyer's client_id and once for the seller's.
  const sql = `
    SELECT
      t.trade_id,
      t.price,
      t.quantity,
      t."timestamp",
      t.instrument,
      buyer_order.client_id AS buy_client_id,
      seller_order.client_id AS sell_client_id
    FROM
      trades AS t
    JOIN
      orders AS buyer_order ON t.buy_order_id = buyer_order.order_id
    JOIN
      orders AS seller_order ON t.sell_order_id = seller_order.order_id
    ORDER BY
      t."timestamp" DESC
    LIMIT $1;
  `;
  
  try {
    const { rows } = await db.query(sql, [limit]);
    return rows;
  } catch (err) {
    console.error('Error fetching detailed trades:', err);
    throw new Error('Failed to fetch detailed trades.');
  }
}

/**
 * Fetches a single order by its UUID.
 * @param {string} orderId - The UUID of the order to fetch.
 * @returns {Promise<object | undefined>} The order object, or undefined if not found.
 */
async function getOrderById(orderId) {
  const sql = `
    SELECT * FROM orders
    WHERE order_id = $1;
  `;
  
  try {
    const { rows } = await db.query(sql, [orderId]);
    return rows[0]; // Returns the order or undefined
  } catch (err) {
    console.error(`Error fetching order ${orderId}:`, err);
    throw new Error('Failed to fetch order.');
  }
}

// --- Add the new function to your exports ---
module.exports = {
  // ... (all your other exports)
  getDetailedTrades,
  getOrderById // <-- ADD THIS
};



module.exports = {
  checkIdempotency,
  saveNewOrder,
  createTrade,
  updateOrderStatus,
  getFormattedOrderBook,
  getRecentTrades,
  getDetailedTrades,
  getOrderById
  // ... other functions like getOrder, getOpenOrders, etc.
};