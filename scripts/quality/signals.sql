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
