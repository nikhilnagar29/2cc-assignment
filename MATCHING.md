
---

# Matching Engine Strategy 

This document explains the internal logic of the matching engine (`matching.engine.js`), how it processes jobs, and how it uses Redis to maintain a high-performance, consistent order book.

## 1. Core Principles

The engine is built on three core principles:

1.  **Asynchronous & Queued:** The API layer (e.g., `POST /orders`) does no matching. It only validates, saves to Postgres, and enqueues a job in BullMQ. This makes the API extremely fast.
2.  **Single-Threaded Worker:** The matching engine is a BullMQ worker with `concurrency: 1`. This is a deliberate design choice. It processes **one job at a time** (either a new order or a cancellation) in the order it receives them. This **guarantees data consistency** and **eliminates all race conditions** without needing complex database locks.
3.  **Price-Time Priority:** This is the fundamental rule of the exchange, as required by the assignment.
    * **Price:** The best price (highest bid, lowest ask) is always matched first.
    * **Time:** If two orders are at the *same* price, the one that arrived *first* (earliest timestamp) is matched first.

## 2. Redis Data Structure (The "Filing Cabinet")

To achieve Price-Time Priority, we do *not* use a simple sorted set. We use a combination of data structures that acts like a "filing cabinet."

* **`orders` (HASH)**
    * **Analogy:** The "Rolodex" or "Master Data File."
    * **Purpose:** Stores the *data* for every single limit order resting on the book.
    * **Key:** `orders`
    * **Field:** `order-id-abc`
    * **Value:** `JSON.stringify({ client_id, quantity, created_at, total_filled_quantity })`
    * **Note:** The `quantity` stored here is the **remaining quantity** of the order.

* **`bids:prices` & `asks:prices` (Sorted Sets)**
    * **Analogy:** The sorted "Filing Cabinet Drawers."
    * **Purpose:** Stores a sorted list of all unique price levels that have orders.
    * **Key:** `bids:prices` (for buy orders)
    * **Score:** `70000` (the price)
    * **Member:** `"70000"` (the price)
    * This lets us find the best price in `O(log n)` time (e.g., `ZREVRANGE` for bids).

* **`bids:[price]` & `asks:[price]` (LISTs)**
    * **Analogy:** The "Folders" inside each drawer.
    * **Purpose:** Stores the `order_id`s for a *single* price level, in the order they arrived (time priority).
    * **Key:** `bids:70000`
    * **Value:** `["order-id-first", "order-id-second", "order-id-third"]`
    * New orders are added with `RPUSH` (to the back). Matches are taken from `LPOP` (from the front).



## 3. Job Processing

The engine's entry point is `processOrderJob`. It receives a job from the BullMQ queue and checks its name:

1.  **`process-order`:** The job contains a full order object. It calls either `matchMarketOrder` or `matchLimitOrder`.
2.  **`process-cancellation`:** The job contains an `{ order_id }`. It calls `handleCancelJob`.

---

## 4. Core Logic: Adding an Order (The "Write Path")

This logic is in `addOrderToBook(order)`. This function is called when a **Limit Order** is not fully filled and needs to rest on the book.

It executes an atomic `redis.multi()` transaction with 4 commands:

1.  **`HSET orders {order_id} {...}`:** Adds the order's details (remaining quantity, client ID, etc.) to the "Rolodex" (master HASH).
2.  **`ZADD [side]:prices {price} {price}`:** Adds the price to the "Filing Cabinet Drawer" (ZSET).
3.  **`RPUSH [side]:{price} {order_id}`:** Adds the order ID to the *back* of the "Folder" (LIST) for that price, maintaining time priority.


## 5. Core Logic: Matching an Order (The "Read/Write Path")

This is the main loop in `processMatchingLoop(takerOrder)`.

1.  **Identify Opponent:** It determines the opposing side (e.g., `asks` if the taker is a `buy`).
2.  **Start Loop:** It runs `while (takerOrder has quantity left)`.
3.  **Find Best Price:** It gets the best price from the opposing `...:prices` ZSET (e.g., `zrange asks:prices 0 0` to get the lowest ask). If no price exists, the loop breaks.
4.  **Check Limit Price:** If the `takerOrder` is a `limit` order, it checks if its price can be matched (e.g., `taker.price >= maker.price`). If not, the loop breaks.
5.  **Find Oldest Order:** It gets the *oldest* order ID at that price by using **`LPOP`** on the `...:[price]` LIST. This atomically pulls the first-in-line order.
6.  **Get Maker Data:** It fetches the maker's full details from the `orders` HASH.
7.  **Calculate Trade:** It calculates `tradeQty = Math.min(takerQtyNeeded, makerQtyAvailable)`.
8.  **Execute Trade:**
    * `persistence.createTrade()`: Saves the trade to Postgres.
    * `broadcast.publishTrade()`: Sends the trade to the WebSocket.
    * `metrics.orders_matched_total.inc()`: Increments the Prometheus counter.
9.  **Update Depth:**
    * `redis.hincrbyfloat([side]:depth, ...)`: **Subtracts** the `tradeQty` from the "Summary Sheet."
10. **Update Taker:** The `takerOrder`'s `filled_quantity` is updated in memory.
11. **Update Maker (The "Resting" Order):**
    * **If Maker is Fully Filled:**
        * `redis.hdel('orders', ...)`: Deletes the order from the "Rolodex."
        * `persistence.updateOrderStatus(..., 'filled')`: Updates Postgres.
    * **If Maker is Partially Filled:**
        * `redis.hset('orders', ...)`: **Updates** the "Rolodex" with the *new remaining quantity*.
        * `redis.lpush([side]:{price}, ...)`: **Pushes the order ID back onto the *front* of the line (LIST),** so it keeps its time priority for the next match.
        * `persistence.updateOrderStatus(..., 'partially_filled')`: Updates Postgres.
12. **Broadcast Updates:** Sends `order_update` messages for *both* the taker and maker orders.
13. **Cleanup:**
    * `redis.llen(...)`: Checks if the "Folder" (LIST) for that price is now empty.
    * If empty, `redis.zrem(...)`: Removes the price from the "Filing Cabinet" (ZSET).
    * `broadcast.publishBookDelta()`: Sends the new quantity (or "0") for that price level to the WebSocket.
14. **Loop:** The `while` loop continues until the taker is filled or the book is empty.

## 6. Core Logic: Cancelling an Order (The "Delete Path")

This logic is in `handleCancelJob(orderId)`.

1.  **Check for Race Condition:** It first checks `redis.hget('orders', orderId)`. If the order is `null`, it means it was *already fully filled* by a previous job. The function logs this and exits successfully.
2.  **Get Order Data:** If the order *is* found, it gets its details (quantity, price, side) from both Redis and Postgres.
3.  **Execute Atomic Removal:** It runs a `redis.multi()` transaction to:
    * **`LREM [side]:{price} 1 {order_id}`:** Removes the order ID from the "Folder" (LIST).
    * **`HDEL orders {order_id}`:** Deletes the order from the "Rolodex" (HASH).
    * **`HINCRBYFLOAT [side]:depth {price} -{quantity}`:** Subtracts the order's remaining quantity from the "Summary Sheet."
4.  **Cleanup:** It checks if the "Folder" (LIST) is now empty and runs `redis.zrem` to clean up the "Drawer" (ZSET) if needed.
5.  **Finalize:** It updates the order's status in Postgres to `cancelled` and broadcasts the cancellation.