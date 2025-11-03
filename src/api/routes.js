// src/api/routes.js
const express = require('express');
const orderController = require('../controllers/order.controller');
const adminController = require('../controllers/admin.controller');

const router = express.Router();

// Order routes
router.post('/orders', orderController.handleCreateOrder);
router.get('/orderbook', orderController.handleGetOrderBook);
router.get('/trades', orderController.handleGetRecentTrades);
router.get('/trades/detailed', orderController.handleGetDetailedTrades); // <-- ADD THIS LINE
router.get('/orders/:order_id', orderController.handleGetOrderStatus);
router.post('/orders/:order_id/cancel', orderController.handleCancelOrder);
// Admin routes
router.get('/healthz', adminController.handleGetHealth);
router.get('/metrics', adminController.handleGetMetrics);

module.exports = router;