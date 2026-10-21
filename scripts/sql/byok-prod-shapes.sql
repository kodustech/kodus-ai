-- Dump every BYOK config an ACTIVE customer has stored, credentials redacted.
--
-- Feeds `scripts/refresh-byok-prod-shapes.mjs`, which anonymises the hostnames,
-- collapses the rows into distinct SHAPES and rewrites the corpus the BYOK
-- config matrix replays (libs/llm/testing/__fixtures__/byok-prod-shapes.json).
--
--   psql "$PROD_REPLICA_URL" -At -f scripts/sql/byok-prod-shapes.sql > dump.json
--   node scripts/refresh-byok-prod-shapes.mjs dump.json --check
--
-- The `--check` run fails when production has grown a shape the matrix never
-- replays, which is the whole point: an uncovered shape is a config we ship
-- untested. A shape going ABSENT is ordinary churn and does not fail.
--
-- TWO THINGS WORTH KNOWING BEFORE EDITING THIS:
--
-- 1. The customer filter is EXISTS, not a JOIN. An organization has one
--    auth_integration PER TEAM and platform, so joining would multiply a single
--    byok_config into as many rows as the org has integrations — every "how many
--    orgs run this shape" count downstream would be inflated by an unrelated
--    number. EXISTS asks the same question ("is this org still connected?")
--    without touching the row count.
--
-- 2. The redaction below is belt-and-braces. `refresh-byok-prod-shapes.mjs`
--    strips every credential field again on its own and REFUSES to write a
--    fixture that still contains one, or any org UUID. Either layer alone is
--    enough; both exist because this data leaves the database.
--
--    `jsonb_set(..., false)` — the trailing false — means "do not create the key
--    if it is absent". Without it a Bedrock-only config would grow an empty
--    `apiKey`, and an OpenAI one would grow AWS fields, inventing shapes that do
--    not exist in production.

SELECT json_agg(jsonb_build_object(
    'organization_id', op.organization_id,
    'configValue',
    CASE WHEN jsonb_typeof(op."configValue") = 'object' THEN
        jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
        jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
            op."configValue",
            '{main,apiKey}',                 to_jsonb('REDACTED'::text), false),
            '{main,awsBearerToken}',         to_jsonb('REDACTED'::text), false),
            '{main,awsAccessKeyId}',         to_jsonb('REDACTED'::text), false),
            '{main,awsSecretAccessKey}',     to_jsonb('REDACTED'::text), false),
            '{main,awsSessionToken}',        to_jsonb('REDACTED'::text), false),
            '{fallback,apiKey}',             to_jsonb('REDACTED'::text), false),
            '{fallback,awsBearerToken}',     to_jsonb('REDACTED'::text), false),
            '{fallback,awsAccessKeyId}',     to_jsonb('REDACTED'::text), false),
            '{fallback,awsSecretAccessKey}', to_jsonb('REDACTED'::text), false),
            '{fallback,awsSessionToken}',    to_jsonb('REDACTED'::text), false)
    ELSE op."configValue" END
))
FROM organization_parameters op
WHERE op."configKey" = 'byok_config'
  AND EXISTS (
      SELECT 1
      FROM auth_integrations ai
      WHERE ai.organization_id = op.organization_id
        AND ai.status = true
  );
