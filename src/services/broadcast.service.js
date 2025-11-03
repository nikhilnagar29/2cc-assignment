// src/services/broadcast.service.js
const WebSocket = require('ws');

let wss; // This will be our WebSocket Server
const clients = new Set(); // Stores all connected clients

/**
 * Initializes the WebSocket server by attaching it to the main HTTP server.
 * @param {http.Server} httpServer - The raw HTTP server from Node.js
 */
function initialize(httpServer) {
  wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    clients.add(ws);

    // Send a welcome message
    ws.send(JSON.stringify({ event: 'connected', data: 'Welcome!' }));

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      clients.delete(ws);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
  });
}

/**
 * Sends a JSON message to every connected client.
 * @param {object} message - The data to broadcast (will be JSON.stringified)
 */
function broadcast(message) {
  if (!wss) {
    console.warn('WebSocket server not initialized.');
    return;
  }
  
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// --- Helper functions for the matching engine ---

function publishTrade(tradeData) {
  broadcast({ event: 'new_trade', data: tradeData });
}

function publishOrderUpdate(orderData) {
  broadcast({ event: 'order_update', data: orderData });
}

function publishBookDelta(deltaData) {
  // deltaData = { side: 'ask', price: 70100, new_quantity: '2.5' }
  broadcast({ event: 'orderbook_delta', data: deltaData });
}

module.exports = {
  initialize,
  publishTrade,
  publishOrderUpdate,
  publishBookDelta,
};