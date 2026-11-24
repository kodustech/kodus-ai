-- What the product API's read-only role (kodus_runtime_reader, RUNTIME_DATABASE_READ_URL)
-- may read in the Runtime database (ADR-025): SELECT on these tables and views only, and
-- only scope/org/cleared_at of runtime_stops (fail-closed external admission). No write
-- grant of any kind. Idempotent; run against the Runtime database after the Runtime's first
-- boot of each release (the Runtime creates the tables). Applied by dev-runtime-users.sh and,
-- in the integration suite, by runtime-reader-grants.integration.spec.ts.
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'runtime') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA runtime TO kodus_runtime_reader';
    FOREACH t IN ARRAY ARRAY[
      'runtime_cells', 'runtime_egress_events', 'runtime_egress_approvals', 'runtime_run_events',
      'runtime_claims', 'runtime_machine_usage',
      -- The Run projection, the environment setups and the lessons (runtime-schema.ts v21).
      'runtime_runs', 'runtime_environment_setups', 'runtime_lessons',
      -- The sandbox operations, counted by the usage report (v22; never output or file content).
      'runtime_sandbox_audit',
      -- The cells' live sessions (connected, free slots, isolation, driver): the Health screen's cells.
      'runtime_cell_sessions',
      -- Preview activity for the owner and the usage report (v27; ids, actions and counts, never an IP or a path).
      'runtime_preview_audit',
      -- The build states a cell evicted (v33; ids and a time): the environment needs a setup again.
      'runtime_build_state_evictions',
      -- Where each memory snapshot is and the PR a session holds (v30, v31): the PR session sweep.
      'runtime_snapshot_cells',
      -- The org's egress switch and who may add, and the approvals' audit (v32): Settings, Runtime, Outbound access.
      'runtime_egress_settings', 'runtime_egress_audit',
      -- The org's own daily machine minutes (v35): Settings, Runtime, machine minutes.
      'runtime_org_machine_budget',
      -- Each Run's outcome of the kept checks (v37; ids, outcome and reason code): the kept checks list and its metric.
      'runtime_kept_check_results',
      -- The e2e suite's runs, shards, results, baselines and spec durations (v51; docs/runtime/e2e-suites.md): the suite
      -- page and the environment's suite settings. Results hold redacted errors cut to the evidence limits, never a secret.
      'runtime_suite_runs', 'runtime_suite_shards', 'runtime_suite_results', 'runtime_suite_baselines', 'runtime_suite_spec_stats',
      -- The shadow check of selection (v57, D14): the product issues the queued shadows and shows what selection missed and whether it is off.
      'runtime_suite_shadows', 'runtime_suite_selection_state'
    ] LOOP
      IF to_regclass(format('runtime.%I', t)) IS NOT NULL THEN
        EXECUTE format('GRANT SELECT ON runtime.%I TO kodus_runtime_reader', t);
      END IF;
    END LOOP;
    -- The org owner's list of registration tokens (docs/runtime/self-hosted.md): hashes and times only;
    -- the token itself is never stored. Columns of migration 26 included.
    IF to_regclass('runtime.runtime_cell_tokens') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT (token_hash, organization_id, topology, issued_by, created_at, expires_at, used_at, revoked_at) ON runtime.runtime_cell_tokens TO kodus_runtime_reader';
    END IF;
    -- The environment template builds waiting for their setup (v47, docs/runtime/host-providers.md §8.2): the
    -- product issues their setup command. Ids, state and the setup key only, never the snapshot name.
    IF to_regclass('runtime.runtime_env_templates') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT (org_id, environment_id, state, setup_key, setup_requested_at) ON runtime.runtime_env_templates TO kodus_runtime_reader';
    END IF;
    -- The fleet's hosts of an e2e suite run (docs/runtime/e2e-suites.md section 13): the suite tab says where its time went.
    -- The org, the bound key and the times only; never the provider's id, the price or an error.
    IF to_regclass('runtime.runtime_hosts') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT (organization_id, bound_key, created_at, ready_at, terminated_at) ON runtime.runtime_hosts TO kodus_runtime_reader';
    END IF;
    -- The template builds' setup records (v50): the pending-template reader only asks whether a key exists.
    IF to_regclass('runtime.runtime_template_setups') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT (setup_key, organization_id, environment_id) ON runtime.runtime_template_setups TO kodus_runtime_reader';
    END IF;
    -- The baseline suite runs a template turning ready asks for (v52): the product reads the queued ones, with no suite run yet,
    -- and issues the command. Ids, the main commit and the state only, never the bake fingerprint.
    IF to_regclass('runtime.runtime_suite_baseline_requests') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT (suite_run_id, environment_id, organization_id, repository_id, main_sha, state, requested_at) ON runtime.runtime_suite_baseline_requests TO kodus_runtime_reader';
    END IF;
    IF to_regclass('runtime.runtime_stops') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT (scope, organization_id, cleared_at) ON runtime.runtime_stops TO kodus_runtime_reader';
    END IF;
  END IF;
END $$;
