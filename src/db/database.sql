-- Create custom ENUM types for data integrity
CREATE TYPE order_side AS ENUM ('buy', 'sell');
CREATE TYPE order_type AS ENUM ('limit', 'market');
CREATE TYPE order_status AS ENUM (
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected'
);

-----------------------------------------------------------------
-- Table 1: orders
-- Stores a permanent record of every order received
-----------------------------------------------------------------
CREATE TABLE orders (
  -- IDs
  order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id VARCHAR(255) NOT NULL,

  -- Details
  instrument VARCHAR(20) NOT NULL,
  side order_side NOT NULL,
  type order_type NOT NULL,
  
  -- Use NUMERIC for exact financial values (precision, scale)
  price NUMERIC(19, 8), -- NULLable for market orders
  quantity NUMERIC(19, 8) NOT NULL,
  
  -- State
  filled_quantity NUMERIC(19, 8) NOT NULL DEFAULT 0.0,
  status order_status NOT NULL,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the GET /orders/{order_id} API
-- (Postgres creates a primary key index automatically)

-- Index for finding a client's orders
CREATE INDEX idx_orders_client_id ON orders(client_id);

-- CRITICAL index for fast crash recovery
CREATE INDEX idx_orders_open_status ON orders(status)
WHERE status = 'open' OR status = 'partially_filled';


-----------------------------------------------------------------
-- Table 2: trades
-- Stores a log of every executed trade
-----------------------------------------------------------------
CREATE TABLE trades (
  trade_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Foreign keys linking the two matched orders
  buy_order_id UUID NOT NULL REFERENCES orders(order_id),
  sell_order_id UUID NOT NULL REFERENCES orders(order_id),

  instrument VARCHAR(20) NOT NULL,
  
  -- The actual price and quantity of the trade
  price NUMERIC(19, 8) NOT NULL,
  quantity NUMERIC(19, 8) NOT NULL,
  
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the GET /trades API (fetches most recent trades)
CREATE INDEX idx_trades_timestamp_desc ON trades(timestamp DESC);

-- Indexes to find all trades for a specific order
CREATE INDEX idx_trades_buy_order_id ON trades(buy_order_id);
CREATE INDEX idx_trades_sell_order_id ON trades(sell_order_id);


-----------------------------------------------------------------
-- Table 3: order_book_snapshots
-- Stores periodic snapshots for fast recovery
-----------------------------------------------------------------
CREATE TABLE order_book_snapshots (
  snapshot_id BIGSERIAL PRIMARY KEY,
  instrument VARCHAR(20) NOT NULL,
  
  -- Stores the full { "bids": [...], "asks": [...] } object
  snapshot_data JSONB NOT NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index to quickly find the *latest* snapshot for recovery
CREATE INDEX idx_snapshots_instrument_latest ON order_book_snapshots(instrument, created_at DESC);


-----------------------------------------------------------------
-- Table 4: idempotency_keys
-- (If you don't use Redis for this)
-----------------------------------------------------------------
-- CREATE TABLE idempotency_keys (
--   idempotency_key VARCHAR(255) PRIMARY KEY,
  
--   -- The order created by this key
--   order_id UUID NOT NULL REFERENCES orders(order_id),
  
--   -- When the key was first seen
--   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
-- );

-- -- Index to help clean up old keys (e.g., after 24h)
-- CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys(created_at);