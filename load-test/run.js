// load-test/run.js
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const TARGET_URL = 'http://localhost:3000/orders';
const TOTAL_REQUESTS = 10000; // --- CHANGED to 10,000 ---
const CONCURRENCY_LIMIT = 200; // How many requests to send at once

const latencies = [];
let successCount = 0;
let failCount = 0;

/**
 * Generates a random order.
 * 70% chance of a Limit order, 30% chance of a Market order.
 */
function generateRandomOrder() {
  const side = Math.random() < 0.5 ? 'buy' : 'sell';
  const quantity = (Math.random() * 0.5 + 0.01).toFixed(4); // Qty between 0.01 and 0.51
  
  if (Math.random() < 0.7) {
    // 70% Limit Order
    const price = (70000 + (Math.random() * 100 - 50)).toFixed(2); // Price around 70k
    return {
      idempotency_key: uuidv4(),
      client_id: `client-${Math.floor(Math.random() * 1000)}`,
      instrument: "BTC-USD",
      side: side,
      type: "limit",
      price: parseFloat(price),
      quantity: parseFloat(quantity)
    };
  } else {
    // 30% Market Order
    return {
      idempotency_key: uuidv4(),
      client_id: `client-${Math.floor(Math.random() * 1000)}`,
      instrument: "BTC-USD",
      side: side,
      type: "market",
      quantity: parseFloat(quantity)
    };
  }
}

/**
 * Sends a single request and records its performance
 */
async function sendRequest() {
  const order = generateRandomOrder();
  const startTime = process.hrtime.bigint();
  
  try {
    const response = await axios.post(TARGET_URL, order, {
      timeout: 10000, // 10 seconds
    });
    
    if (response.status === 202) {
      successCount++;
    } else {
      failCount++;
    }
  } catch (error) {
    // console.error(error.message);
    failCount++;
  } finally {
    const endTime = process.hrtime.bigint();
    // Latency in milliseconds
    const latency = Number(endTime - startTime) / 1_000_000;
    latencies.push(latency);
  }
}

/**
 * Runs the main test
 */
async function runLoadTest() {
  console.log('Starting load test...');
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Total Requests: ${TOTAL_REQUESTS}`);
  console.log(`Concurrency: ${CONCURRENCY_LIMIT}\n`);
  
  const startTime = Date.now();
  
  let requestsSent = 0;
  
  // We'll run in batches to manage concurrency
  while (requestsSent < TOTAL_REQUESTS) {
    const batchSize = Math.min(CONCURRENCY_LIMIT, TOTAL_REQUESTS - requestsSent);
    const promises = [];
    
    for (let i = 0; i < batchSize; i++) {
      promises.push(sendRequest());
    }
    
    // Wait for the entire batch to complete
    await Promise.allSettled(promises);
    
    requestsSent += batchSize;
    process.stdout.write(`Completed ${requestsSent}/${TOTAL_REQUESTS} requests...\r`);
  }
  
  const totalTime = (Date.now() - startTime) / 1000; // Total time in seconds
  
  printReport(totalTime);
}

/**
 * Calculates and prints the final report
 */
function printReport(totalTime) {
  console.log('\n\n--- Load Test Report ---');
  console.log(`Total Time: ${totalTime.toFixed(2)} seconds`);
  
  // Calculate RPS
  const rps = (successCount / totalTime).toFixed(2);
  console.log(`Requests Per Second (RPS): ${rps}`);
  
  console.log(`\nTotal Requests: ${TOTAL_REQUESTS}`);
  console.log(`Successful (202): ${successCount}`);
  console.log(`Failed (non-202): ${failCount}`);
  
  // Calculate latencies
  latencies.sort((a, b) => a - b);
  const min = latencies[0].toFixed(2);
  const max = latencies[latencies.length - 1].toFixed(2);
  const median = latencies[Math.floor(latencies.length / 2)].toFixed(2);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(2);
  const p99 = latencies[Math.floor(latencies.length * 0.99)].toFixed(2);

  // --- NEW: Calculate Average (Mean) ---
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avg = (sum / latencies.length).toFixed(2);
  
  console.log('\n--- Latency (ms) ---');
  console.log(`Min:    ${min} ms`);
  console.log(`Average: ${avg} ms`); // <-- ADDED
  console.log(`Median: ${median} ms`);
  console.log(`p95:    ${p95} ms`);
  console.log(`p99:    ${p99} ms`);
  console.log(`Max:    ${max} ms`);

  if (parseFloat(rps) >= 2000 && parseFloat(median) <= 100) {
    console.log('\n✅ PASSED! System meets performance targets.');
  } else {
    console.log('\n❌ FAILED! System does not meet 2000 rps / sub-100ms median target.');
  }
}

// Run the test
runLoadTest();