// src/services/matching.engine.js
const { createOrderWorker } = require('../config/queue');
const persistence = require('./persistence.service');
const redis = require('../config/redis').connection;
// const broadcast = require('./broadcast.service'); // Uncomment when ready
const { metrics } = require('./metrics.service');

// A small number for safe floating-point comparisons
const EPSILON = 1e-8;

// --- Job Processor Function ---
async function processOrderJob(job) {
  // --- MODIFICATION: Check the job name ---
  const jobName = job.name;
  const orderData = job.data;
  const jobId = job.id;
  const endTimer = metrics.order_latency_seconds.startTimer();
  
  try {
    if (jobName === 'process-order') {
      // --- This is the original logic for a new order ---
      const order = {
        ...orderData,
        price: Number(orderData.price) || null,
        quantity: Number(orderData.quantity),
        filled_quantity: Number(orderData.filled_quantity)
      };
      
      console.log(`[JOB ${jobId}] Processing NEW order ${order.order_id}...`);
      let finalOrder;
      if (order.type === 'market') {
        finalOrder = await matchMarketOrder(order);
      } else {
        finalOrder = await matchLimitOrder(order);
      }
      console.log(`[JOB ${jobId}] Finished order ${finalOrder.order_id}. Final Status: ${finalOrder.status}`);
    
    } else if (jobName === 'process-cancellation') {
      // --- This is the new logic for a cancellation ---
      console.log(`[JOB ${jobId}] Processing CANCELLATION for order ${orderData.order_id}...`);
      await handleCancelJob(orderData.order_id);
      console.log(`[JOB ${jobId}] Finished CANCELLATION for order ${orderData.order_id}.`);
    }

  } catch (error) {
    console.error(`[JOB ${jobId}] CRITICAL ERROR processing ${jobName} for order ${orderData.order_id}:`, error);
    throw error;
  } finally {
    endTimer(); // Stop the latency timer
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

    const makerData = JSON.parse(makerOrderJSON);
    const makerOrder = {
      ...makerData,
      order_id: makerOrderId,
      side: opposingSide,
      price: tradePrice,
    };
    makerOrder.quantity = Number(makerData.quantity);
    makerOrder.total_filled_quantity = Number(makerData.total_filled_quantity) || 0; 

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

    metrics.orders_matched_total.inc();

    // --- FIX #1: SUBTRACT the traded quantity from the depth hash ---
    const depthKey = `${opposingSide}:depth`;
    await redis.hincrbyfloat(depthKey, tradePrice, -tradeQty);
    // --- END FIX ---

    // 7. Update taker order (in memory)
    takerOrder.filled_quantity += tradeQty;

    // 8. Update maker order (in Redis and Postgres)
    const makerNewRemainingQty = makerOrder.quantity - tradeQty;
    const makerNewFilledQty = makerOrder.total_filled_quantity + tradeQty;

    if (makerNewRemainingQty <= EPSILON) {
      // Maker order is fully FILLED
      await redis.hdel('orders', makerOrder.order_id);
      await persistence.updateOrderStatus(makerOrder.order_id, 'filled', makerNewFilledQty);
      // await broadcast.publishOrderUpdate(...);
    } else {
      // Maker order is PARTIALLY FILLED
      const makerDataToSave = {
        client_id: makerOrder.client_id,
        quantity: makerNewRemainingQty,
        created_at: makerOrder.created_at,
        total_filled_quantity: makerNewFilledQty
      };
      await redis.hset('orders', makerOrder.order_id, JSON.stringify(makerDataToSave));
      
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
  const { order_id, price, side, quantity, client_id, created_at, total_filled_quantity } = order;
  
  const bookSide = (side === 'buy') ? 'bids' : 'asks';
  const pricesKey = `${bookSide}:prices`;
  const priceListKey = `${bookSide}:${price}`;
  const depthKey = `${bookSide}:depth`; // The key for the depth hash

  const orderData = JSON.stringify({
    client_id,
    quantity, // This is the *remaining* quantity
    created_at,
    total_filled_quantity: total_filled_quantity || 0 // Store current total filled
  });

  // Use a MULTI transaction for atomicity
  try {
    await redis.multi()
      .hset('orders', order_id, orderData)         // Add order data to hash
      .zadd(pricesKey, price, price)           // Add price to sorted set
      .rpush(priceListKey, order_id)           // Add order to end of list (time priority)
      
      // --- FIX #2: ADD the new quantity to the depth hash ---
      .hincrbyfloat(depthKey, price, quantity)
      // --- END FIX ---
      
      .exec();
  } catch (err) {
    console.error(`Failed to add order ${order_id} to book:`, err);
    throw new Error('Failed to update Redis order book.');
  }
}

/**
 * Safely removes an order from the live Redis order book.
 * This runs inside the single-threaded worker, so it's safe from race conditions.
 * @param {string} orderId The ID of the order to remove.
 */
async function handleCancelJob(orderId) {
  // 1. Check if the order is *still* in the live book (it might have been filled)
  const orderJSON = await redis.hget('orders', orderId);

  if (!orderJSON) {
    // This is not an error. It just means the order was fully filled
    // by a previous job before this cancellation job could run.
    console.log(`Order ${orderId} not found in live book. Already filled.`);
    return; // The job is done.
  }
  
  // 2. Order is still live. We must remove it.
  const orderData = JSON.parse(orderJSON);
  const { quantity, total_filled_quantity } = orderData;
  
  // We need to get the price and side from the master Postgres record
  const pgOrder = await persistence.getOrderById(orderId);
  if (!pgOrder) throw new Error(`Cannot find Postgres record for live order ${orderId}`);
  
  const { side, price } = pgOrder;
  const bookSide = (side === 'buy') ? 'bids' : 'asks';
  const pricesKey = `${bookSide}:prices`;
  const priceListKey = `${bookSide}:${price}`;
  const depthKey = `${bookSide}:depth`;

  // 3. Use a MULTI transaction to remove the order atomically
  try {
    const pipeline = redis.multi();
    
    // a. Remove from the price LIST
    pipeline.lrem(priceListKey, 1, orderId); // Remove 1 instance of orderId
    
    // b. Remove from the HASH
    pipeline.hdel('orders', orderId);
    
    // c. Subtract its quantity from the DEPTH hash
    pipeline.hincrbyfloat(depthKey, price, -Number(quantity));
    
    await pipeline.exec();

    // 4. Check if the price level is now empty
    const listLength = await redis.llen(priceListKey);
    if (listLength === 0) {
      // Clean up the empty price level from the ZSET
      await redis.zrem(pricesKey, price);
    }
    
    // 5. Update the master Postgres record to 'cancelled'
    await persistence.updateOrderStatus(orderId, 'cancelled', total_filled_quantity);
    
    // await broadcast.publishOrderUpdate(...); // Uncomment when ready

  } catch (err) {
    console.error(`Failed to remove order ${orderId} from book:`, err);
    throw new Error('Failed to update Redis order book during cancellation.');
  }
}


// --- Worker Initialization ---
const orderWorker = createOrderWorker(processOrderJob);

console.log('Matching engine (worker) started and listening for jobs...');

module.exports = orderWorker;