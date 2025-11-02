Of course. Here is a clear breakdown of all the APIs you need to build for the assignment, explaining what each one does.

-----

### \#\# HTTP APIs

These are the standard request-response endpoints that clients will use to interact with your system.

#### **User-Facing APIs**

These are the primary endpoints for traders.

  * **`POST /orders`**

      * **Purpose:** The main endpoint to **submit new orders** (both `limit` and `market`).
      * **Request Body:** Contains all order details, including the crucial `idempotency_key` to prevent duplicate submissions.
        ```json
        {
          "idempotency_key": "clientA-12345",
          "client_id": "client-A",
          "instrument": "BTC-USD",
          "side": "buy",
          "type": "limit",
          "price": 70150.5,
          "quantity": 0.25
        }
        ```
      * **Response:** An immediate confirmation (`201` or `202`) that the order was accepted, including its server-generated `order_id` and initial `status` (`open` or `rejected`).

  * **`POST /orders/{order_id}/cancel`**

      * **Purpose:** To **cancel an existing `open` or `partially_filled` order**.
      * **Request Body:** None. The `order_id` is in the URL.
      * **Response:** The final state of the order, showing its new status as `cancelled`.

  * **`GET /orderbook`**

      * **Purpose:** To get a **snapshot of the current market depth**. This is what UIs use to display the order book.
      * **Query Parameters:**
          * `instrument=BTC-USD` (required, but you only support one).
          * `levels=20` (optional, to specify how many price levels to show).
      * **Response:** A JSON object containing two arrays: `bids` (buy orders, sorted high to low) and `asks` (sell orders, sorted low to high).

  * **`GET /trades`**

      * **Purpose:** To fetch a list of the **most recent trades** that have occurred on the exchange.
      * **Query Parameters:**
          * `limit=50` (optional, to specify how many recent trades to return).
      * **Response:** An array of trade objects.

  * **`GET /orders/{order_id}`**

      * **Purpose:** To **check the current status of a specific order**. This is essential for clients to "catch up" if they were disconnected.
      * **Response:** The full order object, including its current `status` and `filled_quantity`.

-----

#### **Admin & Operational APIs**

These are for monitoring and managing the service.

  * **`GET /healthz`**

      * **Purpose:** A simple **health check** endpoint. It should check its connections (like to the database) and return a `200 OK` if everything is running. Used by systems like Docker or Kubernetes to know if the service is alive.

  * **`GET /metrics`**

      * **Purpose:** To expose **internal performance counters** in a format that the Prometheus monitoring system can read.
      * **Response:** Plain text data for metrics like `orders_received_total`, `order_latency_seconds`, etc.

  * **`POST /admin/snapshot`**

      * **Purpose:** An internal endpoint to **trigger an on-demand snapshot** of the live order book from Redis to be saved into Postgres for faster recovery.

-----

### \#\# WebSocket API (The Live Feed 📡)

A WebSocket provides a persistent, two-way connection between the server and the client. Unlike HTTP where the client always has to *ask* for information (pull), a WebSocket allows the server to *push* information to the client instantly.

  * **Endpoint:** **`WS /stream`**

  * **Purpose:** To **broadcast real-time market events** to all connected clients simultaneously. This avoids the need for clients to constantly poll the HTTP APIs and provides a much faster, more efficient user experience.

  * **How it Works:**

    1.  A client (like a trading UI) establishes a single WebSocket connection to your `/stream` endpoint.
    2.  The connection stays open.
    3.  When your **Matching Engine** executes a trade or an order's status changes, it publishes an event.
    4.  Your server's `BroadcastService` immediately sends that event data down the WebSocket connection to **every connected client**.

  * **Events You Must Broadcast:**

      * **New Trades:** When a match occurs, broadcast the trade details (price, quantity, timestamp).
        ```json
        { "event": "new_trade", "data": { ...trade details... } }
        ```
      * **Order Book Deltas:** When a limit order is added, cancelled, or fully filled, broadcast the change to the order book so UIs can update.
        ```json
        { "event": "book_delta", "data": { "side": "ask", "price": 70100, "new_quantity": 0.5 } }
        ```
      * **Order State Changes:** Broadcast updates for individual orders. The client's application can listen and filter for updates to its own `client_id`.
        ```json
        { "event": "order_update", "data": { "order_id": "xyz-123", "status": "partially_filled", ... } }
        ```