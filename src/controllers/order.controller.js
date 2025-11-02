// src/controllers/order.controller.js
const orderService = require('../services/order.service');

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
      res.status(409).json({ error: error.message }); // 409 Conflict
    } else if (error.message.startsWith('Invalid order')) {
      res.status(400).json({ error: error.message }); // 400 Bad Request
    } else {
      // This will catch Redis or Postgres failures
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
}

module.exports = {
  handleCreateOrder,
  // ... other handlers like handleGetOrderBook, etc.
};