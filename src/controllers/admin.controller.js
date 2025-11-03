const healthService = require('../services/health.service');
const persistence = require('../services/persistence.service');
const { registry } = require('../services/metrics.service'); // <-- 1. IMPORT REGISTRY
/**
 * Handles the GET /healthz request.
 * Checks DB and Redis connections.
 */
async function handleGetHealth(req, res) {
  try {
    // 1. Call the service to check health
    const healthStatus = await healthService.checkHealth();
    
    // 2. If all OK, send 200
    res.status(200).json(healthStatus);

  } catch (error) {
    console.error('Service health check failed:', error.message);
    // 3. If any service is down, send 503 Service Unavailable
    res.status(503).json(JSON.parse(error.message));
  }
}

/**
 * Handles the GET /metrics request.
 * Returns all registered metrics in Prometheus format.
 */
async function handleGetMetrics(req, res) {
  try {
    // 1. Set the content type for Prometheus
    res.setHeader('Content-Type', registry.contentType);
    
    // 2. Send the metrics
    res.end(await registry.metrics());

  } catch (error) {
    console.error('Failed to get metrics:', error.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

module.exports = {
  handleGetHealth,
  handleGetMetrics
};