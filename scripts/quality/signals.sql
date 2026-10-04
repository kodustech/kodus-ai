-- quality.signals: one row per quality signal per run. Contract: docs/quality-signals.md
-- Idempotent. Apply with scripts/quality/apply.sh (bq query, standard SQL scripting).

CREATE TABLE IF NOT EXISTS `kody-408918.quality.signals` (
  ts        TIMESTAMP NOT NULL OPTIONS (description = 'When the signal was measured'),
  source    STRING    NOT NULL OPTIONS (description = 'Producer, e.g. kodus-ai/tests.yml or kodus-quality/pull'),
  name      STRING    NOT NULL OPTIONS (description = '<area>.<gate>[.<dimension>], lowercase, dots only'),
  status    STRING    NOT NULL OPTIONS (description = 'green | yellow | red | skipped | infra'),
  value     FLOAT64            OPTIONS (description = 'The number, when there is one'),
  unit      STRING             OPTIONS (description = 'ratio | count | usd | ms | pct'),
  run_url   STRING             OPTIONS (description = 'Where a human goes to see why'),
  commit    STRING,
  branch    STRING,
  meta      JSON               OPTIONS (description = 'Anything else: breakdowns, failed names, links')
)
PARTITION BY DATE(ts)
CLUSTER BY name
OPTIONS (description = 'Quality signals. Producers write; the dashboard and the digest read. Never computed here.');

-- Last row per name.
CREATE OR REPLACE VIEW `kody-408918.quality.signals_latest` AS
SELECT * EXCEPT (rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY ts DESC) AS rn
  FROM `kody-408918.quality.signals`
) WHERE rn = 1;

-- Last row per name per day: what a sparkline reads.
CREATE OR REPLACE VIEW `kody-408918.quality.signals_daily` AS
SELECT * EXCEPT (rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY name, DATE(ts) ORDER BY ts DESC) AS rn
  FROM `kody-408918.quality.signals`
) WHERE rn = 1;

-- One row per production error signature per UTC day, written by kodus-insights
-- (nightly-errors.yml). Real and noise signatures alike; `noise` says which.
-- prod.errors.new_signatures / spikes are judged against the previous 14 days here.
CREATE TABLE IF NOT EXISTS `kody-408918.quality.error_signatures` (
  day          DATE      NOT NULL,
  key          STRING    NOT NULL OPTIONS (description = 'service :: context :: normalized message'),
  service      STRING,
  context      STRING,
  template     STRING    OPTIONS (description = 'message with ids, numbers, urls and quoted strings collapsed'),
  count        INT64,
  noise        BOOL      OPTIONS (description = 'matched a known noise signature (kodus-insights context/error-noise.json)'),
  noise_reason STRING,
  orgs_distinct INT64,
  prs          INT64,
  first_seen   TIMESTAMP,
  last_seen    TIMESTAMP,
  sample       STRING    OPTIONS (description = 'one raw message, truncated; never a PR body'),
  error_names  JSON,
  run_url      STRING,
  ts           TIMESTAMP
)
PARTITION BY day
CLUSTER BY key
OPTIONS (description = 'Production error signatures per day. Source of the Sentry-like new/spike detection and the dashboard /errors page.');

-- One row per 👎 on a suggestion (and the daily delivered cohort per org and
-- origin), written by kodus-quality pull from the BigQuery prod mirror; the
-- kodus-insights weekly classifier fills `bucket`. The dashboard /feedback page,
-- the thumbs_down_* MCP tools and feedback.thumbs_down.worsening read here.
-- The pull job creates both tables itself (CREATE TABLE IF NOT EXISTS, same DDL:
-- kodus-quality libs/bq/src/feedback.ts); listed here so this file stays the
-- one place that says what the dataset holds.
CREATE TABLE IF NOT EXISTS `kody-408918.quality.feedback_items` (
  day DATE NOT NULL, ts TIMESTAMP,
  key STRING NOT NULL OPTIONS (description = 'org_id:pr_number:suggestion_id, same as kodus-insights feedbackId'),
  org_id STRING, org_name STRING, repo STRING, pr_number INT64, pr_url STRING, pr_title STRING,
  file STRING, language STRING, label STRING, severity STRING,
  origin STRING OPTIONS (description = 'detector | rule | generalist; NULL when the suggestion was not found'),
  rule_id STRING, rule_title STRING,
  summary STRING, content STRING, existing_code STRING, improved_code STRING, implementation_status STRING, thumbs_up INT64,
  bucket STRING, bucket_owner STRING, bucket_reason STRING, classified_at TIMESTAMP,
  run_url STRING, written_at TIMESTAMP)
PARTITION BY day CLUSTER BY org_id, rule_id;

CREATE TABLE IF NOT EXISTS `kody-408918.quality.feedback_daily` (
  day DATE NOT NULL, org_id STRING, org_name STRING, origin STRING,
  delivered INT64, down INT64, up INT64, implemented INT64, written_at TIMESTAMP)
PARTITION BY day CLUSTER BY org_id;
