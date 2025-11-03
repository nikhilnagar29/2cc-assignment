// load-test/test.k6.js
import http from 'k6/http';
import { check } from 'k6';

// --- 1. Test Configuration ---
export const options = {
  // We'll use 200 Virtual Users (VUs) to simulate concurrent traffic
  // This is similar to your Node.js script's concurrency
  vus: 200,
  
  // Run the test for a fixed duration
  duration: '60s',
};

// --- Helper function to create a random order ---
function generateRandomOrder(vu, iter) {
  const side = Math.random() < 0.5 ? 'buy' : 'sell';
  const quantity = (Math.random() * 0.5 + 0.01).toFixed(4);
  const type = Math.random() < 0.7 ? 'limit' : 'market';
  
  const payload = {
    // Generate a unique idempotency key for every single request
    idempotency_key: `vu-${vu}-iter-${iter}-${Math.random().toString(36).substr(2, 9)}`,
    client_id: `client-${vu}`, // Use the VU number as the client
    instrument: "BTC-USD",
    side: side,
    type: type,
    quantity: parseFloat(quantity),
  };
  
  if (type === 'limit') {
    payload.price = parseFloat((70000 + (Math.random() * 100 - 50)).toFixed(2));
  }
  
  return payload;
}

// --- 2. The Main Test Function ---
// This is the code that each Virtual User will run in a loop.
export default function () {
  const url = 'http://localhost:3000/orders';
  
  // Generate a unique order for this iteration
  const payload = generateRandomOrder(__VU, __ITER);
  
  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  // Send the POST request
  const res = http.post(url, JSON.stringify(payload), params);

  // 3. Check the response
  // This is how k6 knows if a request was successful or not.
  check(res, {
    'is status 202 (Accepted)': (r) => r.status === 202,
  });
}