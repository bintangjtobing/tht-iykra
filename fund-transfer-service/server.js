'use strict';

// Simulated B Mobile "Fund Transfer" microservice.
// It generates a continuous stream of successful and failed transfers,
// exposes Prometheus metrics on /metrics, and prints structured JSON logs.
// An admin endpoint lets you raise the failure rate to trigger the alert scenario.

const express = require('express');
const client = require('prom-client');

const PORT = process.env.PORT || 8080;
const BASE_FAILURE_RATE = Number(process.env.BASE_FAILURE_RATE || 0.03); // 3% baseline
const TPS = Number(process.env.TPS || 20); // simulated transfers per second

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'fund_transfer_' });

const transfersTotal = new client.Counter({
  name: 'fund_transfer_requests_total',
  help: 'Total fund transfer attempts',
  labelNames: ['status', 'region', 'channel', 'error_code'],
  registers: [register],
});

const transferDuration = new client.Histogram({
  name: 'fund_transfer_duration_seconds',
  help: 'End to end latency of a fund transfer in seconds',
  labelNames: ['status', 'region'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

const transferAmount = new client.Counter({
  name: 'fund_transfer_amount_rupiah_total',
  help: 'Total rupiah value of successful transfers',
  labelNames: ['region', 'channel'],
  registers: [register],
});

const inFlight = new client.Gauge({
  name: 'fund_transfer_in_flight',
  help: 'Number of transfers currently processing',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------
const REGIONS = ['jakarta', 'surabaya', 'medan', 'makassar', 'bandung'];
const CHANNELS = ['bi_fast', 'rtgs', 'internal', 'qris'];
const ERROR_CODES = ['INSUFFICIENT_FUNDS', 'TIMEOUT', 'DOWNSTREAM_5XX', 'LIMIT_EXCEEDED'];

// runtime knob. Raise this to simulate an incident and fire the alert.
let currentFailureRate = BASE_FAILURE_RATE;
// optional region hotspot. When set, that region gets a much higher failure rate.
let failingRegion = null;

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function simulateOneTransfer() {
  const region = pick(REGIONS);
  const channel = pick(CHANNELS);
  const amount = Math.floor(Math.random() * 5_000_000) + 10_000;

  const end = transferDuration.startTimer({ region });
  inFlight.inc();

  // network plus core banking latency, 30ms to 800ms, sometimes a slow tail
  const latencyMs = 30 + Math.random() * 770 + (Math.random() < 0.02 ? 3000 : 0);

  setTimeout(() => {
    inFlight.dec();

    let failRate = currentFailureRate;
    if (failingRegion && region === failingRegion) failRate = 0.6;

    const failed = Math.random() < failRate;
    const status = failed ? 'failed' : 'success';
    const errorCode = failed ? pick(ERROR_CODES) : 'none';

    transfersTotal.inc({ status, region, channel, error_code: errorCode });
    end({ status });
    if (!failed) transferAmount.inc({ region, channel }, amount);

    log({
      event: 'fund_transfer',
      status,
      region,
      channel,
      amount_rupiah: amount,
      error_code: failed ? errorCode : undefined,
      latency_ms: Math.round(latencyMs),
    });
  }, latencyMs);
}

function log(obj) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), service: 'fund-transfer', ...obj }) + '\n'
  );
}

// drive the simulation
const intervalMs = Math.max(1, Math.floor(1000 / TPS));
setInterval(simulateOneTransfer, intervalMs);

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// Trigger a single transfer on demand.
app.post('/transfer', (_req, res) => {
  simulateOneTransfer();
  res.status(202).json({ accepted: true });
});

// Incident controls. Use these to fire the alert on demand.
app.post('/admin/failure-rate', (req, res) => {
  const rate = Number(req.body && req.body.rate);
  if (Number.isNaN(rate) || rate < 0 || rate > 1) {
    return res.status(400).json({ error: 'rate must be a number between 0 and 1' });
  }
  currentFailureRate = rate;
  log({ event: 'admin_change', field: 'failure_rate', value: rate });
  res.json({ failure_rate: currentFailureRate });
});

app.post('/admin/failing-region', (req, res) => {
  const region = req.body && req.body.region;
  failingRegion = region && REGIONS.includes(region) ? region : null;
  log({ event: 'admin_change', field: 'failing_region', value: failingRegion });
  res.json({ failing_region: failingRegion });
});

app.post('/admin/reset', (_req, res) => {
  currentFailureRate = BASE_FAILURE_RATE;
  failingRegion = null;
  log({ event: 'admin_change', field: 'reset', value: BASE_FAILURE_RATE });
  res.json({ failure_rate: currentFailureRate, failing_region: failingRegion });
});

app.listen(PORT, () => {
  log({ event: 'startup', port: PORT, base_failure_rate: BASE_FAILURE_RATE, tps: TPS });
});
