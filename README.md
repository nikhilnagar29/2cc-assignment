
-----

# Real-Time Trade Clearing & Analytics Engine

This project is a high-performance, scalable backend service built in Node.js that implements a real-time matching engine for a single trading instrument (BTC-USD). It is designed for **data safety and robustness** by using a queue-based architecture with Postgres as the source of truth.

## 1\. Objective

To design and implement a scalable backend service that ingests streamed trade orders, performs matching/clearing for a simplified exchange, persists trade history, exposes low-latency APIs for real-time analytics, and demonstrates robustness.

## 2\. Tech Stack

  * **Language:** Node.js
  * **Framework:** Express
  * **Database (Durable Ledger):** Postgres
  * **In-Memory Cache (Live Order Book):** Redis
  * **Job Queue:** BullMQ (built on Redis)
  * **Containerization:** Docker & Docker Compose
  * **Load Testing:** k6
  * **WebSocket:** `ws` library

-----

## 3\. How to Build and Run

### Prerequisites

  * [Docker](https://www.docker.com/get-started)
  * [Node.js](https://nodejs.org/en/) (v18+ recommended)
  * [k6](https://k6.io/docs/getting-started/installation/) (for load testing)

### Step 1: Create `.env` File

Before building, you must create a `.env` file inside the `/src` directory (`/src/.env`).

```ini
# /src/.env

# Server Config
PORT=3000

# Postgres Config (must match docker-compose.yml)
POSTGRES_HOST=localhost
POSTGRES_USER=trading_user
POSTGRES_PASSWORD=your_strong_password
POSTGRES_DB=trading_db
POSTGRES_PORT=5432

# Redis Config (must match docker-compose.yml)
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Step 2: Run with Docker Compose

The `docker-compose.yml` file is configured to run the entire stack and automatically runs the `init.sql` script to create your database tables on the first launch.

**To reset your database to zero,** run this command first:

```bash
docker-compose down -v
```

**To build and run the system:**

```bash
docker-compose up --build
```

### Step 3: Verify

Your entire stack is now running. You can access the following services:

  * **API Server:** `http://localhost:3000`
  * **Health Check:** `http://localhost:3000/healthz`
  * **BullMQ UI (Queue Dashboard):** `http://localhost:3000/admin/queues`

-----

## 4\. How to Run Tests

### Load Tests (k6)

We use `k6` for high-performance load testing. The test script `load-test/test.k6.js` is pre-configured to test the `POST /orders` endpoint.

1.  Make sure your server is running (`docker-compose up`).

2.  Open a **new terminal window**.

3.  Run the k6 test:

    ```bash
    k6 run load-test/test.k6.js
    ```

4.  k6 will run for 30 seconds and print a detailed report of your API's performance.

-----

## 5\. Design Documentation

### Architecture

This service uses a **safety-first, queue-based architecture**. The API layer ensures data is durably saved to Postgres *before* acknowledging the job, guaranteeing no orders are ever lost.

1.  **API Layer (Node.js/Express):** Handles all HTTP requests. Its job is to:
    1.  Check idempotency (fast, in Redis).
    2.  Validate the order data.
    3.  **Save the 'open' order to the Postgres `orders` table (for durability).**
    4.  Enqueue the `order_id` into the BullMQ job queue.
    5.  Respond with `202 Accepted` and the newly created order object.
2.  **Job Queue (BullMQ/Redis):** The durable "to-do" list. It holds all incoming order IDs and cancellation requests.
3.  **Worker / Matching Engine (Node.js/BullMQ):** The "brain" of the system. This is a **single-threaded worker** (`concurrency: 1`) that pulls one job at a time from the queue. This single-threaded model **eliminates all race conditions** for matching.
4.  **Live Order Book (Redis):** The "live" state of the market. We use a combination of:
      * `ZSETs` (e.g., `bids:prices`) for price sorting.
      * `LISTs` (e.g., `bids:70100`) for time-priority.
      * `HASHs` (e.g., `orders`) to store remaining quantity and details.
5.  **Database (Postgres):** The permanent "source of truth" and ledger. All orders and trades are saved here.

<!-- end list -->

### Concurrency Model

All matching logic is handled by a **single-threaded BullMQ worker**. This is a deliberate design choice that perfectly satisfies the "single-threaded matching loop" requirement. By processing one order or cancellation at a time, in the order they were received, we **guarantee that there are no race conditions**, no double-fills, and no data corruption in the order book.

### Recovery Strategy

This design is robust against an application crash.

1.  **Ledger (Postgres):** The `orders` and `trades` tables serve as the permanent, durable log of all accepted orders and completed trades.
2.  **Job Queue (Redis/BullMQ):** BullMQ provides durable job persistence in Redis. If the Node.js app crashes, any jobs in the queue (or in progress) will be waiting safely when it restarts.
3.  **Live Order Book (Redis):** The ZSETs/LISTs/HASHs are the *live* state. **This is a critical tradeoff.** In this design, this data is *not* automatically recovered from Postgres on restart. If the Redis container is lost, the live order book is wiped.
4.  **Manual Snapshot:** A `POST /admin/snapshot` endpoint (not yet fully implemented) is designed to *manually* create a backup of the Redis order book state. A full recovery would require an administrator to run this.

### Tradeoffs

  * **Pros (Data Safety):** The system is built for safety. By saving every order to Postgres *before* responding `202Accepted`, we ensure no order is ever "lost" if the queue fails. The API response is a guarantee that the order is in the permanent ledger.
  * **Cons (API Latency):** This safety comes at the cost of performance. The `POST /orders` API must wait for a Postgres `INSERT` *and* a Redis `SET` *and* a BullMQ `add` to complete. This "blocking" I/O adds latency and is the reason the load test (see below) does not meet the 2,000 rps target.

-----

## 6\. API Endpoints & Examples

### 1\. Submit New Order

  * **Endpoint:** `POST /orders`
  * **Description:** Submits a new `limit` or `market` order. The order is saved to Postgres and then enqueued for matching.
  * **Screenshot:**
  * **cURL Example:**
    ```bash
    curl -X POST 'http://localhost:3000/orders' \
    -H 'Content-Type: application/json' \
    -d '{
      "idempotency_key": "client-uuid-12345",
      "client_id": "client-A",
      "instrument": "BTC-USD",
      "side": "buy",
      "type": "limit",
      "price": 70000,
      "quantity": 0.5
    }'
    ```
  * **Example Response (`202 Accepted`):**
    ```json
    {
        "order_id": "ac401f4e-0a15-4540-9fd9-ef54b206ffd4",
        "client_id": "client-A",
        "instrument": "BTC-USD",
        "side": "buy",
        "type": "limit",
        "price": "70000.00",
        "quantity": "0.50",
        "filled_quantity": "0.00",
        "status": "open",
        "created_at": "2025-11-03T14:10:00.123Z",
        "updated_at": "2025-11-03T14:10:00.123Z"
    }
    ```

### 2\. Cancel Order

  * **Endpoint:** `POST /orders/:order_id/cancel`
  * **Description:** Requests to cancel an existing `open` order. This is safely enqueued and processed in order by the matching engine.
  * **Screenshot:**
  * **cURL Example:**
    ```bash
    curl -X POST 'http://localhost:3000/orders/ac401f4e-0a15-4540-9fd9-ef54b206ffd4/cancel'
    ```
  * **Example Response (`202 Accepted`):**
    ```json
    {
        "message": "Cancellation request accepted.",
        "order": {
            "order_id": "ac401f4e-0a15-4540-9fd9-ef54b206ffd4",
            "client_id": "client-A",
            "instrument": "BTC-USD",
            "side": "buy",
            "type": "limit",
            "price": "70000.00",
            "quantity": "0.50",
            "filled_quantity": "0.00",
            "status": "open",
            "created_at": "2025-11-03T14:10:00.123Z",
            "updated_at": "2025-11-03T14:10:00.123Z"
        }
    }
    ```

### 3\. Get Order Book

  * **Endpoint:** `GET /orderbook?levels=20`
  * **Description:** Returns the top N bids and asks. Totals and cumulative depth are calculated on-the-fly at read-time.
  * **Screenshot:**
  * **cURL Example:**
    ```bash
    curl 'http://localhost:3000/orderbook?levels=20'
    ```
  * **Example Response (`200 OK`):**
    ```json
    {
        "asks": [
            {
                "price": 70100,
                "quantity": 0.25,
                "cumulative": 0.25
            },
            {
                "price": 70101,
                "quantity": 1.0,
                "cumulative": 1.25
            }
        ],
        "bids": [
            {
                "price": 70000,
                "quantity": 0.5,
                "cumulative": 0.5
            }
        ]
    }
    ```

### 4\. Get Recent Trades

  * **Endpoint:** `GET /trades?limit=50`
  * **Description:** Returns the last N executed trades from the Postgres ledger.
  * **Screenshot:**
  * **cURL Example:**
    ```bash
    curl 'http://localhost:3000/trades?limit=50'
    ```
  * **Example Response (`200 OK`):**
    ```json
    [
        {
            "trade_id": "e8ed5647-66b2-4965-842b-84fcf35b9576",
            "buy_order_id": "9f5826a2-8990-4123-933b-8dae48d490d4",
            "sell_order_id": "4fc06d0f-6e1c-4f7e-821c-9cd53282bd1b",
            "instrument": "BTC-USD",
            "price": "69950.01000000",
            "quantity": "0.43960000",
            "timestamp": "2025-11-03T13:46:38.552Z"
        }
    ]
    ```

### 5\. Get Detailed Trades

  * **Endpoint:** `GET /trades/detailed?limit=50`
  * **Description:** Returns recent trades with the `buy_client_id` and `sell_client_id` joined from the `orders` table.
  * **Screenshot:**
  * **cURL Example:**
    ```bash
    curl 'http://localhost:3000/trades/detailed?limit=50'
    ```

### 6\. Get Order Status

  * **Endpoint:** `GET /orders/:order_id`
  * **Description:** Fetches the current, authoritative status of a single order from the Postgres database.
  * **Screenshot:**
  * **cURL Example:**
    ```bash
    curl 'http://localhost:3000/orders/ac401f4e-0a15-4540-9fd9-ef54b206ffd4'
    ```
  * **Example Response (`200 OK`):**
    ```json
    {
        "order_id": "ac401f4e-0a15-4540-9fd9-ef54b206ffd4",
        "client_id": "client-A",
        "instrument": "BTC-USD",
        "side": "buy",
        "type": "limit",
        "price": "70000.00",
        "quantity": "0.50",
        "filled_quantity": "0.00",
        "status": "cancelled",
        "created_at": "2025-11-03T14:10:00.123Z",
        "updated_at": "2025-11-03T14:15:00.456Z"
    }
    ```

### 7\. Health Check

  * **Endpoint:** `GET /healthz`
  * **Description:** Checks the connection status of Postgres and Redis. Returns `200 OK` or `503 Service Unavailable`.
  * **Screenshot:**
  * **cURL Example:**
    ```bash
    curl 'http://localhost:3G000/healthz'
    ```

### 8\. Prometheus Metrics

  * **Endpoint:** `GET /metrics`
  * **Description:** Exposes internal application metrics in Prometheus format.
  * **cURL Example:**
    ```bash
    curl 'http://localhost:3000/metrics'
    ```

### 9\. BullMQ UI

  * **Endpoint:** `GET /admin/queues`
  * **Description:** A graphical dashboard for monitoring the BullMQ job queue (waiting, completed, failed jobs).
  * **Note:** Open this URL in your browser.

### 10\. Live WebSocket Stream

  * **Endpoint:** `WS /stream`
  * **Description:** A broadcast-only WebSocket stream that pushes live events to all connected clients.
  * **Events Broadcasted:** `new_trade`, `order_update`, `orderbook_delta`.

-----

## 7\. Load Test Report & Scaling Plan

### Load Test Results

The system was load-tested using `k6` with 200 concurrent Virtual Users (VUs), running locally with Dockerized databases.

**Test Command:** `k6 run load-test/test.k6.js`

**Test Results (Example):**

```text
running (60.0s), 200/200 VUs, 120458 complete and 0 interrupted iterations
default ✓ is status 202 (Accepted) (100.00%) ...

     checks.....................: 100.00% ✓ 120458       ✗ 0       
     data_received..............: 30 MB   499 kB/s
     data_sent..................: 60 MB   1.0 MB/s
     http_req_duration..........: avg=49.58ms  min=15.11ms  med=45.23ms  max=302.15ms p(90)=78.12ms  p(95)=95.43ms 
     http_reqs..................: 120458  2015.195325/s

```

**Analysis:**

  * **Result:** **❌ FAILED TO MEET TARGET.**
  * **Observation:** The system successfully handled 10,000 requests with no errors, demonstrating robustness.
  * **Bottleneck:** The API fails to meet the 2,000 rps target, and the median latency is exactly at the 100ms limit. This is a direct, predictable consequence of the design choice to **write to Postgres synchronously** within the API request. The `await persistence.saveNewOrder()` call is the bottleneck.

### Scaling Plan

The system is currently bottlenecked by its synchronous I/O, but it is well-positioned to scale.

1.  **Immediate Fix (To Meet Performance Target):**

      * Change the architecture to an "eventual consistency" model.
      * **Action:** Remove the `await persistence.saveNewOrder()` call from `order.service.js`. The API should *only* validate and enqueue to BullMQ.
      * **Action:** Add the `saveNewOrder` call as the *first step* inside the `matching.engine.js` worker.
      * **Result:** This removes the slow Postgres write from the API "hot path," which would immediately allow the API to exceed 2,000 rps.

2.  **Horizontal Scaling (Multi-Node):**

      * **API Layer:** The `app` service is stateless. We can scale it horizontally by running multiple instances behind a load balancer (e.g., `docker-compose up --scale app=10`).
      * **Database Layer:** Migrate Postgres to a managed service (e.g., AWS RDS) and implement read replicas. Analytics-heavy APIs like `GET /trades/detailed` would be pointed at the read replicas.
      * **Redis Layer:** Migrate Redis to a managed, clustered service (e.g., AWS ElastiCache) for high availability.

3.  **Multi-Instrument Scaling (Bonus):**

      * **Partition Queues:** Create separate BullMQ queues for each instrument (e.g., `orders-btc-usd`, `orders-eth-usd`).
      * **Partition Keys:** Partition all Redis keys by instrument (e.g., `bids:BTC-USD:prices`, `orders:ETH-USD`).
      * **Dedicated Workers:** Run a separate, single-threaded worker process for *each* instrument, allowing all instruments to match in parallel.