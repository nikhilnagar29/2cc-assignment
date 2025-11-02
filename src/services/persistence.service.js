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

module.exports = {
  checkIdempotency,
  saveNewOrder,
  createTrade,
  updateOrderStatus
  // ... other functions like getOrder, getOpenOrders, etc.
};