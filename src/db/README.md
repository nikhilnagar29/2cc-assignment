
---

# 📘 Postgres Database Schema

This document describes the **PostgreSQL schema** for the Trading Engine’s persistent storage. It includes details about the tables, custom data types, and relationships designed to ensure consistency, performance, and data integrity.

---

## 🧩 Custom Types (ENUMs)

To maintain strict data integrity and avoid invalid values, we define custom ENUM types for order properties.

```sql
CREATE TYPE order_side AS ENUM ('buy', 'sell');
CREATE TYPE order_type AS ENUM ('limit', 'market');
CREATE TYPE order_status AS ENUM (
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected'
);
```

---

## 📄 Table: `orders`

The `orders` table serves as a **permanent ledger** for every order request received by the trading engine.

| **Column Name**   | **Data Type**   | **Description**                                      |
| ----------------- | --------------- | ---------------------------------------------------- |
| `order_id`        | `UUID (PK)`     | Unique identifier for the order.                     |
| `client_id`       | `VARCHAR(255)`  | The ID of the client who placed the order.           |
| `instrument`      | `VARCHAR(20)`   | The trading pair, e.g., `"BTC-USD"`.                 |
| `side`            | `order_side`    | Indicates whether the order is a `buy` or `sell`.    |
| `type`            | `order_type`    | Order type — either `limit` or `market`.             |
| `price`           | `NUMERIC(19,8)` | Limit price. `NULL` for market orders.               |
| `quantity`        | `NUMERIC(19,8)` | Total quantity the client wants to trade.            |
| `filled_quantity` | `NUMERIC(19,8)` | Quantity already traded. *(Default: 0)*              |
| `status`          | `order_status`  | Current state of the order (`open`, `filled`, etc.). |
| `created_at`      | `TIMESTAMPTZ`   | Timestamp when the order was created.                |
| `updated_at`      | `TIMESTAMPTZ`   | Timestamp when the order was last modified.          |

---

## 💱 Table: `trades`

The `trades` table is a **permanent log** of every executed trade (match) in the trading engine.

| **Column Name** | **Data Type**   | **Description**                                                |
| --------------- | --------------- | -------------------------------------------------------------- |
| `trade_id`      | `UUID (PK)`     | Unique identifier for the trade.                               |
| `buy_order_id`  | `UUID (FK)`     | The `order_id` of the buyer. *(References `orders.order_id`)*  |
| `sell_order_id` | `UUID (FK)`     | The `order_id` of the seller. *(References `orders.order_id`)* |
| `instrument`    | `VARCHAR(20)`   | Trading pair, e.g., `"BTC-USD"`.                               |
| `price`         | `NUMERIC(19,8)` | The price at which the trade was executed.                     |
| `quantity`      | `NUMERIC(19,8)` | Amount traded in this transaction.                             |
| `timestamp`     | `TIMESTAMPTZ`   | Exact time the trade occurred.                                 |

---

## 🧾 Table: `order_book_snapshots`

The `order_book_snapshots` table stores **point-in-time snapshots** of the order book for fast crash recovery and analytics.

| **Column Name** | **Data Type**    | **Description**                                                  |
| --------------- | ---------------- | ---------------------------------------------------------------- |
| `snapshot_id`   | `BIGSERIAL (PK)` | Auto-incrementing unique ID for the snapshot.                    |
| `instrument`    | `VARCHAR(20)`    | Trading pair the snapshot corresponds to.                        |
| `snapshot_data` | `JSONB`          | Full order book data — e.g., `{ "bids": [...], "asks": [...] }`. |
| `created_at`    | `TIMESTAMPTZ`    | Timestamp when the snapshot was taken.                           |

---

## 🏗️ Notes

* **Data integrity** is enforced using ENUMs and foreign key constraints.
* **Timestamps** use `TIMESTAMPTZ` for accurate time tracking with time zone support.
* **JSONB** allows efficient querying of structured snapshot data.

---

Would you like me to also include SQL `CREATE TABLE` scripts for each table (so you can directly use it in migrations)?
