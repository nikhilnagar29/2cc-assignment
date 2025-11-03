// src/controllers/order.controller.js
const orderService = require('../services/order.service');
const persistence = require('../services/persistence.service');
const healthService = require('../services/health.service');
const { metrics } = require('../services/metrics.service'); // <-- 1. IMPORT METRICS

async function handleCreateOrder(req, res) {
  const orderData = req.body;
  
  try {
    const savedOrder = await orderService.submitOrder(orderData);
    
    // **202 Accepted**
    // This is the correct code: "We've accepted the request,
    // and it's being processed in the background."
    res.status(202).json(savedOrder);
    
  } catch (error) {
    console.error('Order submission failed:', error.message);
    
    // This error handling now catches our new validation errors too
    if (error.message.startsWith('Duplicate order')) {
        metrics.orders_rejected_total.inc(); 
      res.status(409).json({ error: error.message }); // 409 Conflict
    } else if (error.message.startsWith('Invalid order')) {
        metrics.orders_rejected_total.inc();
      res.status(400).json({ error: error.message }); // 400 Bad Request
    } else {
      // This will catch Redis or Postgres failures
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
}

/**
 * Handles the GET /orderbook request.
 */
async function handleGetOrderBook(req, res) {
  try {
    // 1. Validate query param
    const levels = parseInt(req.query.levels) || 20; // Default to 20 levels
    
    // 2. Call the service
    const orderBook = await persistence.getFormattedOrderBook(levels);
    
    // 3. Send response
    res.status(200).json(orderBook);

  } catch (error) {
    console.error('Error fetching order book:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * Handles the GET /trades request.
 */
async function handleGetRecentTrades(req, res) {
  try {
    // 1. Validate query param
    const limit = parseInt(req.query.limit) || 50; // Default to 50 trades
    
    // 2. Call the service
    const trades = await persistence.getRecentTrades(limit);
    
    // 3. Send response
    res.status(200).json(trades);

  } catch (error) {
    console.error('Error fetching recent trades:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * Handles the GET /trades/detailed request.
 */
async function handleGetDetailedTrades(req, res) {
  try {
    // 1. Validate query param
    const limit = parseInt(req.query.limit) || 50; // Default to 50 trades
    
    // 2. Call the service for detailed trades
    const trades = await persistence.getDetailedTrades(limit);
    
    // 3. Send response
    res.status(200).json(trades);

  } catch (error) {
    console.error('Error fetching detailed trades:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * Handles the GET /orders/:order_id request.
 */
async function handleGetOrderStatus(req, res) {
  try {
    // 1. Get the order_id from the URL parameters
    const { order_id } = req.params;

    // 2. Call the service
    const order = await persistence.getOrderById(order_id);
    
    // 3. Handle response
    if (order) {
      res.status(200).json(order);
    } else {
      // If the order is not found
      res.status(404).json({ error: 'Order not found.' });
    }

  } catch (error) {
    console.error('Error fetching order status:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
}


/**
 * Handles the POST /orders/:order_id/cancel request.
 */
async function handleCancelOrder(req, res) {
  try {
    const { order_id } = req.params;
    
    // 1. Call the service to enqueue the cancellation
    const order = await orderService.cancelOrder(order_id);

    // 2. Respond with 202 Accepted
    // This means the cancellation is *queued*, not *confirmed*.
    res.status(202).json({
      message: 'Cancellation request accepted.',
      order: order
    });

  } catch (error) {
    console.error('Order cancellation failed:', error.message);
    if (error.message.startsWith('Not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.startsWith('Invalid state')) {
      res.status(409).json({ error: error.message }); // 409 Conflict
    } else {
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
}



module.exports = {
  handleCreateOrder,
  handleGetOrderBook,
  handleGetRecentTrades,
  handleGetDetailedTrades,
  handleGetOrderStatus,
  handleCancelOrder,
  // ... other handlers like handleGetOrderBook, etc.
};