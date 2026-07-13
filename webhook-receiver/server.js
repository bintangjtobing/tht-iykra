'use strict';

// Mock receiver. It stands in for the WhatsApp Business API and the Internal
// Ticketing System. It accepts the Alertmanager webhook and logs a readable
// summary plus the raw payload to the console.

const express = require('express');

const PORT = process.env.PORT || 9000;
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.post('/webhook', (req, res) => {
  const body = req.body || {};
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];

  console.log('\n==================== OPS VISION ALERT ====================');
  console.log('receivedAt      :', new Date().toISOString());
  console.log('groupStatus     :', body.status);
  console.log('alertCount      :', alerts.length);

  for (const a of alerts) {
    const labels = a.labels || {};
    const ann = a.annotations || {};
    console.log('---------------------------------------------------------');
    console.log('alertname       :', labels.alertname);
    console.log('severity        :', labels.severity);
    console.log('status          :', a.status);
    console.log('summary         :', ann.summary);
    console.log('description     :', ann.description);

    // Simulated WhatsApp fan out to the technical support team.
    console.log('[WHATSAPP] ->', `Ops Vision: ${labels.severity} - ${ann.summary}`);

    // Simulated ticket creation in the internal system.
    if (a.status === 'firing') {
      const ticketId = 'INC-' + labels.alertname + '-' + (labels.region || 'global');
      console.log('[TICKET ] created', ticketId, '|', ann.description);
    } else {
      console.log('[TICKET ] resolved for', labels.alertname);
    }
  }

  console.log('---- raw payload ----');
  console.log(JSON.stringify(body, null, 2));
  console.log('=========================================================\n');

  res.status(200).json({ received: true, alerts: alerts.length });
});

app.listen(PORT, () => {
  console.log(JSON.stringify({ event: 'startup', service: 'webhook-receiver', port: PORT }));
});
