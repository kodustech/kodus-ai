-- Dump every BYOK model slot an ACTIVE customer has stored, without credentials.
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
-- 1. Fields are SELECTED by name, never copied wholesale and redacted. A field
--    reaches the dump only when it is named below, so a field added to the
--    config later stays in the database until someone decides it belongs here.
--    `refresh-byok-prod-shapes.mjs` refuses a dump that carries a credential
--    field anyway.
--
-- 2. The customer filter is EXISTS, not a JOIN. An organization has one
--    auth_integration PER TEAM and platform, so joining would multiply a single
--    byok_config into as many rows as the org has integrations — every "how many
--    orgs run this shape" count downstream would be inflated by an unrelated
--    number. EXISTS asks the same question ("is this org still connected?")
--    without touching the row count.
--
-- One row per configured model, flattened the way `slotFromModel`
-- (libs/llm/resolve-model-slot.ts) builds a slot: the model's own tuning plus
-- the provider and plaintext settings of its credential. A managed credential is
-- the Kodus env default, not a customer shape, and is skipped like the runtime
-- skips it.

SELECT coalesce(json_agg(slot), '[]'::json)
FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object(
        'organization_id',          op.organization_id,
        'provider',                 cred->'provider',
        'model',                    m->'model',
        'baseURL',                  cred->'settings'->'baseURL',
        'vertexLocation',           cred->'settings'->'vertexLocation',
        'awsRegion',                cred->'settings'->'awsRegion',
        'openrouterProviderOrder',  cred->'settings'->'openrouterProviderOrder',
        'openrouterAllowFallbacks', cred->'settings'->'openrouterAllowFallbacks',
        'reasoningEffort',          m->'reasoningEffort',
        'reasoningConfigOverride',  m->'reasoningConfigOverride',
        'temperature',              m->'temperature',
        'maxInputTokens',           m->'maxInputTokens',
        'maxOutputTokens',          m->'maxOutputTokens',
        'maxConcurrentRequests',    m->'maxConcurrentRequests',
        'rpm',                      m->'rpm',
        'tpm',                      m->'tpm',
        'cooldownMs',               m->'cooldownMs'
    )) AS slot
    FROM organization_parameters op
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(op."configValue"->'models') = 'array'
             THEN op."configValue"->'models' ELSE '[]'::jsonb END
    ) AS m
    CROSS JOIN LATERAL (
        SELECT c AS cred
        FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(op."configValue"->'credentials') = 'array'
                 THEN op."configValue"->'credentials' ELSE '[]'::jsonb END
        ) AS c
        WHERE c->>'id' = m->>'credentialId'
        LIMIT 1
    ) AS linked
    WHERE op."configKey" = 'byok_config'
      AND coalesce((cred->>'managed')::boolean, false) = false
      AND EXISTS (
          SELECT 1
          FROM auth_integrations ai
          WHERE ai.organization_id = op.organization_id
            AND ai.status = true
      )
) AS slots;
