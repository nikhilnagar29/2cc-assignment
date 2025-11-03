// src/services/order.service.js
const { orderQueue } = require('../config/queue');
const persistence = require('./persistence.service');
const { metrics } = require('./metrics.service');

/**
 * Handles validation, idempotency, and enqueuing of a new order.
 * This is the "fast" path for the HTTP request.
 */
async function submitOrder(orderData) {
  // **FIX:** Destructuring all required fields for validation
  const { idempotency_key, client_id, instrument, side, type, price, quantity } = orderData;

  // 1. Idempotency Check
  // We throw an error if the key isn't provided, as it's required
  if (!idempotency_key) {
    throw new Error('Invalid order: idempotency_key is required.');
  }
  const isNew = await persistence.checkIdempotency(idempotency_key);
  if (!isNew) {
    // This is a duplicate request
    throw new Error('Duplicate order: Idempotency key already used.');
  }

  // 2. Validation (with client_id and other fields)
  if (!client_id) {
    throw new Error('Invalid order: client_id is required.');
  }
  if (!instrument) {
    throw new Error('Invalid order: instrument is required.');
  }
  if (!side || (side !== 'buy' && side !== 'sell')) {
    throw new Error('Invalid order: side must be "buy" or "sell".');
  }
  if (!type || (type !== 'limit' && type !== 'market')) {
    throw new Error('Invalid order: type must be "limit" or "market".');
  }
  if (!quantity || quantity <= 0) {
    throw new Error('Invalid order: Quantity must be positive.');
  }
  if (type === 'limit' && (!price || price <= 0)) {
    throw new Error('Invalid limit order: Price must be positive.');
  }

  metrics.orders_received_total.inc(); // <-- 2. INCREMENT COUNTER

  // 3. Save to DB (Permanent Record)
  // We save it *before* enqueuing to ensure we have a record
  // even if the queue processing fails.
  // We pass the full, validated orderData object
  const savedOrder = await persistence.saveNewOrder(orderData);

  // 4. Enqueue for processing
  // We add the full order to the job data
  await orderQueue.add('process-order', savedOrder);

  // 5. Return the accepted order
  return savedOrder;
}

/**
 * Checks if an order can be cancelled and enqueues a cancellation job.
 * @param {string} orderId The ID of the order to cancel.
 * @returns {Promise<object>} The order's current state.
 */
async function cancelOrder(orderId) {
  // 1. Get the order's current status from the master DB (Postgres)
  const order = await persistence.getOrderById(orderId);

  // 2. Check if order exists
  if (!order) {
    throw new Error('Not found: Order does not exist.');
  }

  // 3. Check if order is in a "final" state
  if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
    throw new Error('Invalid state: Order is already in a final state.');
  }

  // 4. Enqueue the cancellation job
  // We use a different job name ('process-cancellation')
  // The matching engine will handle this in its single-threaded loop
  await orderQueue.add('process-cancellation', { order_id: orderId });

  // 5. Return the order with a "202 Accepted" status
  return order;
}

module.exports = {
  submitOrder,
  cancelOrder
};