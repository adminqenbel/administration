# Deployment strategy for QenBel Administration

Status: recommendation, not yet decided by the owner. Provider regions, prices and limits below are from memory: confirm each on the provider's site before relying on it. Do not create cloud resources until the owner says so.

## 1. What the platform needs from a host

- Long-running containers, not only serverless: the API, a worker (BullMQ: reminders, hold expiry, outbox and webhook delivery, AI jobs), and the chat/WhatsApp agent runtime.
- PostgreSQL with Row-Level Security, point-in-time recovery and encrypted backups. Redis. S3-compatible object storage.
- Always warm. A sleeping free tier is not acceptable once a voice agent or WhatsApp webhook is live: a cold start of tens of seconds breaks a phone call, and WhatsApp expects a quick 200.
- Data in India (Mumbai region) for Indian customers. Check the DPDP Act position with a lawyer before real customer data.
- One image that runs as central multi-tenant (`DEPLOYMENT_MODE=central`) or as a dedicated single-tenant stack (`isolated`), created repeatably on request.

## 2. Recommendation in one line

**Portable containers + managed Postgres in Mumbai, Cloudflare in front, everything defined as code, in three stages.** Do not use provider-specific services in the application code (S3 API, Postgres, Redis, plain containers only), so the host can change without a rewrite.

## 3. Stages

### Stage A: build and demo (now, about zero spend)
- Local: `infra/docker-compose.yml` (Postgres, Redis, MinIO).
- Web PWA: Cloudflare Pages (the domain is already on Cloudflare; `apps/web/public/_headers` is already in that syntax).
- API + worker: one small container host (Render or Fly.io) with the instance kept warm.
- Database: Supabase or Neon in an India or Singapore region, Postgres only (no Supabase Auth, no browser access to the database), matching how the QenBel portal is run.
- Sample/fake data only. Demos with a real salon or clinic come only after the Stage B safeguards.

### Stage B: first paying customers (recommended production)
Primary recommendation: **AWS Mumbai (ap-south-1)**, kept portable.
- Compute: ECS on Fargate, two services from the same image (`api`, `worker`), minimum 2 tasks each in different zones, autoscaling on CPU and queue depth. No Kubernetes: it adds operations work you do not need at this size.
- Database: RDS for PostgreSQL, Multi-AZ, automated backups with point-in-time recovery, private subnets only, no public endpoint. The app connects as `qenbel_app` (subject to RLS); a separate one-off migration task connects as `qenbel_migrate`.
- Redis: ElastiCache (or a managed Redis in the same region). Files: S3 with block-public-access on and per-tenant key prefixes. Secrets: Secrets Manager, with KMS envelope encryption for per-tenant channel secrets (WhatsApp tokens, voice provider keys).
- Edge: Cloudflare in front (DNS, WAF, rate limiting, TLS), origin locked to Cloudflare. Static web on Cloudflare Pages.
- Everything created from Terraform in the repo (`infra/terraform`), including a dev/staging/prod split. No console clicking: a misconfigured bucket or open security group is the main risk for customer data (the same lesson the portal docs record).
- Why AWS here: repeatable infrastructure-as-code for dedicated stacks, mature managed Postgres with backups, an India region, and the owner's existing credits. The portal docs rejected AWS for that project because credits expire around January and could create a deadline and lock-in. Keep that guard: use only portable pieces, treat credits as a discount rather than a dependency, and keep the Stage A host as a fallback.
- Cheaper alternative if AWS operations feel heavy: Fly.io (Mumbai) or Render for compute with a managed Postgres that has PITR. Same containers, same Terraform-free path, fewer knobs, less isolation control. Choose this if the first customers are few and cost matters more than control.

### Stage C: dedicated (isolated) stacks on request
Three offers, one build:
1. **Shared** (default, cheapest): the central multi-tenant platform. Isolation by `tenant_id` + forced RLS.
2. **Dedicated stack in your cloud account**: Terraform module creates a separate database, services, bucket and secrets for one customer; `DEPLOYMENT_MODE=isolated`; one tenant row. Use one AWS account per customer where possible (an AWS Organization), so a mistake in one cannot touch another.
3. **Bring your own cloud**: the same module applied in the customer's account with a least-privilege role; you operate it through the control plane.
The control plane (platform-admin module) records each stack's URL, version and health; upgrades roll out stack by stack with migrations run as a separate job first. Tie this to the commercial model: the implementation fee pays for configuring and deploying a stack, the platform stays the reusable asset.

## 4. Runtime and operations decisions

- Environments: local, staging (production-shaped, fake data), production. Promotion by image tag; the same image everywhere.
- CI/CD (GitHub Actions on `adminqenbel/administration`): typecheck, all `node --test` suites, `npm audit`, secret scan, build and scan the image, then deploy staging, then a manual approval for production. Migrations run as a job before the new version, written to be backward compatible (expand, then contract).
- Rollout: rolling or blue/green with health checks (`/health`, `/health/db`). Roll back by tag; never roll back a destructive migration.
- Workers: outbox and webhook delivery are idempotent and retried; hold expiry and reminders are scheduled jobs with locks so two workers never double-run.
- Voice and WhatsApp: acknowledge the webhook immediately and queue the work; keep voice tool endpoints on the warm API with a latency budget (target well under a second for `check_availability`). Provider-signed webhooks are verified before any processing. Region near the voice provider's Indian endpoints.
- AI cost control: per-tenant daily token cap and a loop limit enforced server-side, a kill switch per tenant, and usage metering from day one.
- Observability: structured logs with redaction (no message text, phone numbers or tokens), metrics and traces (OpenTelemetry to CloudWatch or Grafana), alerts on error rate, queue depth, hold-expiry lag, webhook failures and database connections. Define SLOs before the first customer (for example availability of the tool gateway and p95 latency of `check_availability`).
- Backups and recovery: point-in-time recovery on the database, daily encrypted snapshot copied to a second region or account, object storage versioning. Targets to start with: RPO 5 minutes, RTO 1 hour. **Run a restore drill before the first real customer**, as the portal docs require.
- Security baseline: private networking for data stores, least-privilege roles per service, no long-lived keys in images or CI (use OIDC to the cloud), image scanning, dependency pinning, WAF rules and per-principal rate limits. The security review findings in `docs/security/` gate the Stage B launch.

## 5. Cost shape (to confirm with current pricing)

- Stage A: close to zero, with a small fixed cost to keep one container warm.
- Stage B shared platform: a small fixed monthly base (two small tasks per service, one Multi-AZ small database, cache, bucket, edge) plus per-use LLM cost, which should be metered and passed through or capped per tenant.
- Stage C dedicated stack: roughly the Stage B base again per customer unless several customers share an account with separate databases on one instance. Price dedicated stacks as a premium tier, not as the default.

## 6. Decisions the owner must make

1. Primary host for Stage B: AWS Mumbai (recommended) or Fly.io/Render with managed Postgres.
2. Auth provider for production: Clerk (as in the portal) or another, which also fixes the web CSP origins.
3. Which LLM provider and region/data-handling terms apply for the chat and WhatsApp agent runtime.
4. Voice and WhatsApp accounts (Meta business verification, template approval, telephony or Sarvam), which have lead time.
5. Retention periods for conversations and customer data, and who is the grievance contact (policy pages must match what the platform does).
6. Whether dedicated stacks are offered in your account, the customer's account, or both.

Nothing here has been created or deployed.
