# Project Guide — Ops Vision Fund Transfer PoC

This guide has one job: make you able to run, explain, defend, and change every part of this project. Read it top to bottom once. After that, use it as a reference.

## Table of contents

1. [What this project is](#1-what-this-project-is)
2. [The request path in one picture](#2-the-request-path-in-one-picture)
3. [How to run it](#3-how-to-run-it)
4. [How to trigger and watch an alert](#4-how-to-trigger-and-watch-an-alert)
5. [Repository structure, file by file](#5-repository-structure-file-by-file)
6. [Concepts you must understand](#6-concepts-you-must-understand)
7. [How to change common things](#7-how-to-change-common-things)
8. [Troubleshooting](#8-troubleshooting)
9. [Questions a reviewer may ask, and how to answer](#9-questions-a-reviewer-may-ask-and-how-to-answer)

---

## 1. What this project is

It is a working slice of an observability platform for one banking flow: the B Mobile "Fund Transfer".

Five services run together:

1. A simulated Fund Transfer microservice that produces success and failed transfers and exposes metrics.
2. Prometheus, which collects those metrics every 5 seconds and evaluates alert rules.
3. Alertmanager, which routes a firing alert to the right destination.
4. A webhook receiver that stands in for the WhatsApp API and the internal ticketing system.
5. Grafana, which draws the dashboard.

The point it proves: when transfers start failing, the system notices within seconds and pushes a notification and a ticket, with no human watching a screen.

---

## 2. The request path in one picture

```
[fund-transfer-service]  emits metrics on /metrics
          |
          |  Prometheus scrapes every 5s   (pull model)
          v
     [Prometheus]  stores metrics + evaluates alert.rules.yml
          |
          |  a rule stays true for 30s -> alert fires
          v
    [Alertmanager]  groups, deduplicates, routes
          |
          |  webhook
          v
  [webhook-receiver]  logs "WhatsApp" message + "ticket created"

     [Grafana]  reads Prometheus and draws the dashboard
```

Read that path out loud once. If you can narrate it, you can defend the project.

---

## 3. How to run it

### The intended way: Docker

This is what a reviewer uses. One command builds and starts all five services.

```bash
docker compose up --build
```

Wait about 20 seconds. Then open:

| Service | URL |
|---------|-----|
| Grafana dashboard | http://localhost:3000/d/fund-transfer |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |
| Service metrics | http://localhost:8080/metrics |

Grafana needs no login. Anonymous viewing is on. If it ever asks, the account is `admin` / `admin`.

Stop everything:

```bash
docker compose down
```

### The native way, without Docker

We used this on a machine that had no Docker. You do not need it if you have Docker. It is documented so you understand what Compose does under the hood: it runs the same five processes.

- The two Node services run with `node server.js`.
- Prometheus and Alertmanager run as local binaries pointed at config files.
- Grafana runs as a local binary with the provisioning folder passed in.

The only difference from Docker is the hostnames in the config. Inside Docker, services find each other by name (`fund-transfer-service:8080`). Running natively, everything is `localhost`. The files in the repo use the Docker names, which is correct for the graded submission.

---

## 4. How to trigger and watch an alert

The service runs at a 3% baseline failure rate. That is below the 10% alert threshold, so the system sits green.

**Step 1. Cause an incident.** Raise the failure rate above the threshold:

```bash
curl -XPOST http://localhost:8080/admin/failure-rate \
  -H 'content-type: application/json' \
  -d '{"rate":0.8}'
```

Or break a single region, which fires the regional alert instead:

```bash
curl -XPOST http://localhost:8080/admin/failing-region \
  -H 'content-type: application/json' \
  -d '{"region":"jakarta"}'
```

**Step 2. Watch it move.**

- Grafana: the "Failure ratio" tile turns red within seconds.
- Prometheus: open http://localhost:9090/alerts. The alert goes from Pending to Firing after 30 seconds.
- Alertmanager: http://localhost:9093 shows the active alert.

**Step 3. See the delivery.** The webhook receiver prints the WhatsApp message and the ticket:

```bash
docker compose logs -f webhook-receiver
```

**Step 4. Recover.**

```bash
curl -XPOST http://localhost:8080/admin/reset
```

The alert resolves on its own. Alertmanager sends a resolved webhook, which the receiver also logs.

---

## 5. Repository structure, file by file

### `fund-transfer-service/server.js`

The simulated microservice. This is the most important file to understand because everything else reacts to it.

What it does:

- Every 40 milliseconds it simulates one transfer. It picks a random region and channel, a random rupiah amount, and a random latency.
- It decides success or failure based on the current failure rate.
- It records the result into Prometheus metrics.
- It prints a structured JSON log line per transfer.
- It simulates calls to three downstream dependencies: the fraud check, the core ledger, and the interbank switch. When a transfer fails, it attributes the failure to one of them.

The metrics it exposes, and why each type:

| Metric | Type | Why this type |
|--------|------|---------------|
| `fund_transfer_requests_total` | Counter | A count that only goes up. You take its rate to get requests per second. |
| `fund_transfer_duration_seconds` | Histogram | Buckets of latency. Lets Prometheus compute p95 and p99 without storing every event. |
| `fund_transfer_amount_rupiah_total` | Counter | Total money moved. Rate gives you rupiah per second. |
| `fund_transfer_in_flight` | Gauge | A value that goes up and down. Current concurrent load. |
| `fund_transfer_dependency_requests_total` | Counter | Downstream calls by result. |
| `fund_transfer_dependency_duration_seconds` | Histogram | Latency of each downstream hop. |

The endpoints:

- `GET /metrics` — Prometheus reads this.
- `GET /healthz` — liveness check.
- `POST /transfer` — fire one transfer by hand.
- `POST /admin/failure-rate` — set the global failure rate. This is your incident switch.
- `POST /admin/failing-region` — break one region.
- `POST /admin/reset` — back to healthy.

### `webhook-receiver/server.js`

Stands in for the WhatsApp Business API and the internal ticketing system, which you cannot call from a laptop. It exposes `POST /webhook`. Alertmanager posts the alert JSON to it. The receiver reads the payload and prints a readable summary, a simulated WhatsApp line, and a simulated ticket line. This proves the integration contract without real bank credentials.

### `prometheus/prometheus.yml`

Prometheus configuration. Three things live here:

- `scrape_configs`: what to collect and how often. It scrapes `fund-transfer-service:8080` every 5 seconds.
- `rule_files`: points to the alert rules file.
- `alerting`: tells Prometheus where Alertmanager is.

### `prometheus/alert.rules.yml`

The brain of the detection logic. Two kinds of rules:

- **Recording rules** precompute expressions and save them under a new name. For example `fund_transfer:failure_ratio:rate1m` is the failure ratio over one minute. Dashboards and alerts reuse it, so the math is written once.
- **Alert rules** compare a value against a threshold. If the condition holds for the `for` duration, the alert fires.

The five alerts: high global failure rate, regional failure spike, downstream dependency errors, high latency, and service down.

### `alertmanager/alertmanager.yml`

Routing. It groups alerts by name and region, waits a few seconds to bundle related ones, and sends them to the webhook receiver. `send_resolved: true` means it also notifies when the problem clears.

### `docker-compose.yml`

Infrastructure as code. It defines all five services, their ports, their config file mounts, and their startup order. This is the single file that turns a folder of configs into a running system.

### `grafana/provisioning/`

Auto-setup for Grafana so nobody clicks through menus.

- `datasources/datasource.yml` connects Grafana to Prometheus.
- `dashboards/dashboard.yml` tells Grafana to load any dashboard JSON from the dashboards folder.

### `grafana/dashboards/fund-transfer.json`

The dashboard definition. 15 panels grouped into four rows: Service health, Regions and channels, Latency and dependencies, and Investigation. Colors carry meaning. Cool blue is normal. Warm amber and red mean a system fault worth paging on. Rupiah values render as IDR currency.

### `docs/`

The architecture diagrams, both as Mermaid source and rendered PNG.

---

## 6. Concepts you must understand

**Pull versus push.** Prometheus pulls. It calls the service's `/metrics` on its own schedule. The service never waits on Prometheus. That is why monitoring cannot slow a transfer. If Prometheus is down, transfers keep working.

**Counter, gauge, histogram.** A counter only rises; you read its `rate()`. A gauge moves both ways; you read it directly. A histogram sorts observations into buckets; you read percentiles from it.

**`rate()`.** Counters grow forever, so the raw number is meaningless. `rate(metric[1m])` gives the per second increase over the last minute. That is how you turn a total into a live signal.

**`histogram_quantile()`.** Turns histogram buckets into a percentile. p95 latency of 1.2s means 95% of transfers finished faster than 1.2 seconds.

**Recording rule versus alert rule.** A recording rule saves a computed value under a new name so you write the math once. An alert rule watches a value and fires when it crosses a line.

**The `for` duration.** An alert with `for: 30s` only fires after the condition is true for 30 continuous seconds. This kills false alarms from a single noisy scrape.

**Alert lifecycle.** Inactive, then Pending while the condition holds but `for` has not elapsed, then Firing. On recovery it becomes Resolved.

**Alertmanager's job.** Prometheus decides what is wrong. Alertmanager decides who hears about it and how. Grouping, deduplication, silencing, and routing by severity all live here.

**Label cardinality.** Every unique label combination is a separate time series. Region has 5 values, channel has 4. Safe. Labeling by account number would create millions of series and crash Prometheus. Never label by a unique id.

---

## 7. How to change common things

**Change an alert threshold.** Edit `prometheus/alert.rules.yml`. Find `FundTransferHighFailureRate` and change `> 0.10`. Restart or reload Prometheus.

**Make an alert fire faster or slower.** Change the `for:` value on that alert.

**Add a new metric.** In `fund-transfer-service/server.js`, declare it near the other metric definitions, then update it inside `simulateOneTransfer`. It appears on `/metrics` automatically.

**Add a dashboard panel.** Edit `grafana/dashboards/fund-transfer.json`, or add it in the Grafana UI and export the JSON. Each panel has a `title`, a `gridPos` for placement, and a `targets` array holding the PromQL query.

**Change how often Prometheus collects.** Edit `scrape_interval` in `prometheus/prometheus.yml`.

**Point the webhook somewhere else.** Edit the `url` in `alertmanager/alertmanager.yml`. In production this points at the real WhatsApp and ticketing integration service.

---

## 8. Troubleshooting

**Grafana dashboard list spins forever.** Open the dashboard directly at http://localhost:3000/d/fund-transfer instead of browsing the list. The backend is fine; the list view is a frontend quirk.

**Prometheus target shows DOWN.** Open http://localhost:9090/targets. Check the service is up and the port matches the scrape config.

**Alert never fires.** Give it time. The 1 minute rate window plus the 30 second `for` means about 60 to 90 seconds after you raise the failure rate. Watch the Pending state on the Prometheus alerts page.

**Webhook receiver logs nothing.** Confirm Alertmanager shows the alert as active, and that the webhook URL in `alertmanager.yml` matches the receiver's address.

**Port already in use.** Another process holds 3000, 8080, 9090, 9093, or 9000. Stop it or change the port mapping in `docker-compose.yml`.

---

## 9. Questions a reviewer may ask, and how to answer

**Why Prometheus and not just logging?** Metrics are cheap to store and fast to query at scale. Millions of transfers a day would drown a log search. Metrics answer "is it broken and how bad" in milliseconds. Logs answer "what happened to this one transfer" and are the second step.

**How does monitoring not slow the bank?** Pull based scraping and emit and forget. The service writes metrics to memory and never blocks on the backend. Prometheus reads on its own schedule. Kafka in the full design absorbs bursts so no storage backend can back-pressure the app.

**Why measure failed transfer value in rupiah, not just a failure count?** Because a 2% failure rate on large RTGS transfers hurts far more than 2% on small QRIS payments. Money ranks incidents by real business impact.

**How do you detect a problem in one region when the global average looks fine?** A per region recording rule. The regional alert fires when any single region crosses 30%, even while the global rate stays low.

**What is your SLO and how does it drive alerting?** 99.9% success over 30 days. That is the error budget. When the burn rate threatens the budget, the system pages. The 10% one minute threshold in the PoC is the fast, obvious version of that idea.

**Why histograms for latency?** They let you compute p95 and p99 without storing every single request, which is essential at millions of transfers a day. Averages hide the slow tail that customers actually feel.

**What breaks first at 10x scale, and what do you do?** A single Prometheus runs out of memory. You move to Mimir or Thanos for horizontal scale and long retention, and you put Kafka in front of ingestion so spikes never hit storage directly. That is already in the Part B architecture.
