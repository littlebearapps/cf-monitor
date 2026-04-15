# cf-monitor Documentation

Self-contained Cloudflare account monitoring. One worker. Zero migrations.

## Getting Started

- **[Step-by-step setup](./getting-started.md)** — from install to verified monitoring in 9 steps

## Configuration

- **[Configuration reference](./configuration.md)** — all `cf-monitor.yaml` and SDK (`MonitorConfig`) options

## Guides

Task-oriented guides for each monitoring feature:

| Guide | What it covers |
|-------|----------------|
| [Error collection](./guides/error-collection.md) | Fingerprinting, dedup, GitHub issues, priority labels, prerequisites |
| [Budgets & circuit breakers](./guides/budgets-and-circuit-breakers.md) | 4 layers of cost protection, per-invocation limits, auto-seeding |
| [Cost protection](./guides/cost-protection.md) | The $4,868 story and how cf-monitor prevents it |
| [Cost spike detection](./guides/cost-spike-detection.md) | Hourly spikes vs 24h baseline, Slack alerts, tuning |
| [Worker discovery](./guides/worker-discovery.md) | Auto-discovery via CF API, exclude patterns, daily cadence |
| [Slack alerts](./guides/slack-alerts.md) | Alert types, dedup, webhook setup |
| [Plan detection](./guides/plan-detection.md) | Free vs Paid, billing period, token permissions |
| [Account usage](./guides/account-usage.md) | GraphQL queries, 5 services, limitations |
| [Gap detection](./guides/gap-detection.md) | Coverage monitoring, AE/KV detection methods |
| [Synthetic health checks](./guides/synthetic-health.md) | Hourly CB pipeline self-test, failure diagnosis |
| [Self-monitoring](./guides/self-monitoring.md) | Cron tracking, error counts, /self-health, AE queries |

## How-to

Step-by-step instructions for specific tasks:

- [GitHub webhooks](./how-to/github-webhooks.md) — bidirectional issue sync setup
- [Gatus heartbeat](./how-to/gatus-heartbeat.md) — external uptime monitor for cf-monitor crons
- [Custom feature IDs](./how-to/custom-feature-ids.md) — featureId, featurePrefix, features map

## Reference

- [Security](./security.md) — admin auth, secrets, threat model, data exposure, SDK security
- [Troubleshooting](./troubleshooting.md) — 14 common issues with solutions
- [Changelog](../CHANGELOG.md) — version history (v0.1.0 to v0.3.8)

## Internal Reports

- [Production pipeline audit](./reports/2026-03-21-production-pipeline-audit.md) — Platform account deployment validation
- [Integration test report](./integration-test-report-2026-03-21.md) — 53 tests across 10 files
