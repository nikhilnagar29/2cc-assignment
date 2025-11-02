// src/services/matching.engine.js
const { createOrderWorker } = require('../config/queue');
const persistence = require('./persistence.service');
const redis = require('../config/redis').connection;
// const broadcast = require('./broadcast.service'); // Uncomment when ready

// A small number for safe floating-point comparisons
const EPSILON = 1e-8;

/**
 * The core logic for processing a single order from the queue.
 */
async function processOrderJob(job) {
  // Cast to Number for safe math, as Postgres/Redis can return strings
  const order = {
    ...job.data,
    price: Number(job.data.price) || null, // Ensure null price for market orders
    quantity: Number(job.data.quantity),
    filled_quantity: Number(job.data.filled_quantity)
  };

  console.log(`[JOB ${job.id}] Processing order ${order.order_id}...`);

  try {
    let finalOrder;
    if (order.type === 'market') {
      finalOrder = await matchMarketOrder(order);
    } else {
      finalOrder = await matchLimitOrder(order);
    }
    console.log(`[JOB ${job.id}] Finished order ${finalOrder.order_id}. Final Status: ${finalOrder.status}`);
  } catch (error) {
    console.error(`[JOB ${job.id}] CRITICAL ERROR processing order ${order.order_id}:`, error);
    // Throwing an error tells BullMQ the job failed
    // It will be retried automatically if configured
    throw error;
  }
}

// --- Main Matching Functions ---

/**
 * Processes a MARKET order.
 */
async function matchMarketOrder(takerOrder) {
  // Process the matching loop
  const updatedTakerOrder = await processMatchingLoop(takerOrder);

  // Mark order as filled or partially_filled (if book was exhausted)
  const remainingQty = updatedTakerOrder.quantity - updatedTakerOrder.filled_quantity;
  const finalStatus = (remainingQty > EPSILON) ? 'partially_filled' : 'filled';

  // Update final status in Postgres
  return persistence.updateOrderStatus(
    updatedTakerOrder.order_id,
    finalStatus,
    updatedTakerOrder.filled_quantity
  );
}

/**
 * Processes a LIMIT order.
 */
async function matchLimitOrder(takerOrder) {
  // 1. Process the matching loop
  const updatedTakerOrder = await processMatchingLoop(takerOrder);
  const remainingQty = updatedTakerOrder.quantity - updatedTakerOrder.filled_quantity;

  // 2. If order is not fully filled, add it to the book
  if (remainingQty > EPSILON) {
    // This order is now a "maker" order
    const restingOrder = {
      ...updatedTakerOrder,
      quantity: remainingQty, // The *remaining* quantity rests on the book
      // We pass the *current* filled_quantity to be stored
      total_filled_quantity: updatedTakerOrder.filled_quantity
    };

    await addOrderToBook(restingOrder);

    // Update status in Postgres to 'open' or 'partially_filled'
    const finalStatus = (updatedTakerOrder.filled_quantity > 0) ? 'partially_filled' : 'open';
    return persistence.updateOrderStatus(
      updatedTakerOrder.order_id,
      finalStatus,
      updatedTakerOrder.filled_quantity
    );

  } else {
    // 3. If order is fully filled, just update status
    return persistence.updateOrderStatus(
      updatedTakerOrder.order_id,
      'filled',
      updatedTakerOrder.filled_quantity
    );
  }
}

/**
 * The core matching loop.
 */
async function processMatchingLoop(takerOrder) {
  const opposingSide = (takerOrder.side === 'buy') ? 'asks' : 'bids';
  const pricesKey = `${opposingSide}:prices`;
  
  // Get prices: ZRANGE for asks (lowest first), ZREVRANGE for bids (highest first)
  const priceSortCmd = (opposingSide === 'asks') ? 'zrange' : 'zrevrange';

  // Loop as long as the taker order has quantity to fill
  while (takerOrder.quantity - takerOrder.filled_quantity > EPSILON) {

    // 1. Find the best price from the opposing book
    const [bestPrice] = await redis[priceSortCmd](pricesKey, 0, 0);
    if (!bestPrice) {
      break; 
    }
    const bestPriceNum = Number(bestPrice);

    // 2. Check for price match (for LIMIT orders)
    if (takerOrder.type === 'limit') {
      const canMatch = (takerOrder.side === 'buy')
        ? (takerOrder.price >= bestPriceNum)
        : (takerOrder.price <= bestPriceNum);
      
      if (!canMatch) {
        break;
      }
    }
    
    // 3. We have a price match! Get the first order (time priority) at that price
    const tradePrice = bestPriceNum;
    const priceListKey = `${opposingSide}:${tradePrice}`;
    
    const makerOrderId = await redis.lpop(priceListKey);
    
    if (!makerOrderId) {
      console.warn(`Orphan price level found: ${priceListKey}. Cleaning up.`);
      await redis.zrem(pricesKey, bestPrice);
      continue;
    }

    // 4. Get the maker order's data
    const makerOrderJSON = await redis.hget('orders', makerOrderId);
    if (!makerOrderJSON) {
      console.warn(`Orphan order ID found: ${makerOrderId}. Skipping.`);
      continue;
    }

    // --- CORRECTION (Bug 1 Fix) ---
    // We now correctly parse the data from the hash
    const makerData = JSON.parse(makerOrderJSON);
    const makerOrder = {
      ...makerData, // Contains client_id, quantity, created_at, total_filled_quantity
      order_id: makerOrderId,
      side: opposingSide,
      price: tradePrice,
    };
    makerOrder.quantity = Number(makerData.quantity); // This is the *remaining* qty
    // This is the *total filled qty* from when it was last on the book
    makerOrder.total_filled_quantity = Number(makerData.total_filled_quantity) || 0; 
    // --- END CORRECTION ---

    // 5. Calculate trade quantities
    const takerQtyNeeded = takerOrder.quantity - takerOrder.filled_quantity;
    const makerQtyAvailable = makerOrder.quantity;
    
    const tradeQty = Math.min(takerQtyNeeded, makerQtyAvailable);
    if (tradeQty <= EPSILON) continue; // Skip if trade is too small

    // 6. Create the trade and update Postgres
    const tradeData = {
      instrument: takerOrder.instrument,
      price: tradePrice,
      quantity: tradeQty,
      buy_order_id: (takerOrder.side === 'buy') ? takerOrder.order_id : makerOrder.order_id,
      sell_order_id: (takerOrder.side === 'sell') ? takerOrder.order_id : makerOrder.order_id,
    };
    await persistence.createTrade(tradeData);
    // await broadcast.publishTrade(tradeData);

    // 7. Update taker order (in memory)
    takerOrder.filled_quantity += tradeQty;

    // 8. Update maker order (in Redis and Postgres)
    const makerNewRemainingQty = makerOrder.quantity - tradeQty;
    // --- CORRECTION (Bug 1 Fix) ---
    // This now correctly calculates the new *total* filled amount
    const makerNewFilledQty = makerOrder.total_filled_quantity + tradeQty;
    // --- END CORRECTION ---

    if (makerNewRemainingQty <= EPSILON) {
      // Maker order is fully FILLED
      await redis.hdel('orders', makerOrder.order_id);
      await persistence.updateOrderStatus(makerOrder.order_id, 'filled', makerNewFilledQty);
      // await broadcast.publishOrderUpdate(...);
    } else {
      // Maker order is PARTIALLY FILLED

      // --- CORRECTION (Bug 2 Fix) ---
      // We create a clean, correct object to save back to the hash
      const makerDataToSave = {
        client_id: makerOrder.client_id,
        quantity: makerNewRemainingQty, // The new remaining qty
        created_at: makerOrder.created_at,
        total_filled_quantity: makerNewFilledQty // The new total filled qty
      };
      await redis.hset('orders', makerOrder.order_id, JSON.stringify(makerDataToSave));
      // --- END CORRECTION ---
      
      // **Put it back at the FRONT of the list (LPUSH)**
      await redis.lpush(priceListKey, makerOrder.order_id);
      
      await persistence.updateOrderStatus(makerOrder.order_id, 'partially_filled', makerNewFilledQty);
      // await broadcast.publishOrderUpdate(...);
    }

    // Update taker status in Postgres (so UI can see partial fills in real-time)
    await persistence.updateOrderStatus(takerOrder.order_id, 'partially_filled', takerOrder.filled_quantity);
    // await broadcast.publishOrderUpdate(...);

    // 9. If list for this price is now empty, remove price from ZSET
    const listLength = await redis.llen(priceListKey);
    if (listLength === 0) {
      await redis.zrem(pricesKey, bestPrice);
    }
  }

  // Return the taker order with its new filled_quantity
  return takerOrder;
}

// --- Redis Order Book Helper Functions ---

/**
 * Adds a new LIMIT order to the resting book in Redis.
 */
async function addOrderToBook(order) {
  // --- CORRECTION ---
  // We now correctly use the 'total_filled_quantity' from the restingOrder object
  const { order_id, price, side, quantity, client_id, created_at, total_filled_quantity } = order;
  const bookSide = (side === 'buy') ? 'bids' : 'asks';
  // --- END CORRECTION ---

  const pricesKey = `${bookSide}:prices`;
  const priceListKey = `${bookSide}:${price}`;

  // --- CORRECTION ---
  // The data saved to the hash now includes the correct total_filled_quantity
  const orderData = JSON.stringify({
    client_id,
    quantity, // This is the *remaining* quantity
    created_at,
    total_filled_quantity: total_filled_quantity || 0 // Store current total filled
  });
  // --- END CORRECTION ---

  // Use a MULTI transaction for atomicity
  try {
    await redis.multi()
      .hset('orders', order_id, orderData)         // Add order data to hash
      .zadd(pricesKey, price, price)           // Add price to sorted set
      .rpush(priceListKey, order_id)           // Add order to end of list (time priority)
      .exec();
  } catch (err) {
    console.error(`Failed to add order ${order_id} to book:`, err);
    throw new Error('Failed to update Redis order book.');
  }
}

// --- Worker Initialization ---
const orderWorker = createOrderWorker(processOrderJob);

console.log('Matching engine (worker) started and listening for jobs...');

module.exports = orderWorker;