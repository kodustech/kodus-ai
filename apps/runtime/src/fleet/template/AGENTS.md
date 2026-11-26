# apps/runtime/src/fleet/template

The environment template on boat (docs/runtime/host-providers.md §8.2): a provider's saved snapshot per environment and pool, made from a setup host that booted only the default branch (S-52), holding the cell, the baked images and the seeded data. A perRun Run host starts `from` it.

## Owns
- `boat-setup-host.ts` `BoatSetupHost`, its `BakeProbe` and `HostSealer` ports.
- `build-template.ts` `buildEnvironmentTemplate` and the `SetupHostPort` it drives: boot a setup host from the environment's previous template (or the cell base), wait for the bake, seal, save, record, replace the older template, destroy the setup host.
- `template-store.ts` `PgTemplateStore` (`runtime_env_templates`) and `StoreTemplateResolver` (what a Run host starts from).
- `template-name.ts` `templateNameOf`: `kodus-env-<org-hash>-<env-hash>-<fingerprint>`, within boat's 63-character names.

## Does not own
- Running the setup on the host: the worker's setup workflow, through the hub, as for any cell.
- The saved-snapshot calls: the provider's `images` (`../providers/boat/boat-provider.ts`).

## Rules and limits
- Only orgs in the pool's admission list: customer data at rest in boat needs legal sign-off first.
- Never a PR's code: the bake must report the default branch and the requested fingerprint, or nothing is saved.
- The saved disk holds no identity: the seal step removes the key, the certificate, the token file and `/tmp` before the save.
- The setup host is destroyed whatever happens; a failed save keeps the older template.
- `boat-setup-host.ts` is the live `SetupHostPort`: boot (token bound to `template:<org>/<env>`, `from` the cell base), wait (`SetupRecordBakeProbe`, `bake-probe.ts`, over the setup record), seal (a `HostSealer` port, then the cell is retired at the hub), destroy. The hub places a setup request that carries `boundKey: template:<org>/<env>` only on the cell bound to that key, and that cell takes nothing else.
- `template-trigger.ts`: `TemplateBuildTrigger` starts a build on a Run's demand with no ready template (through `TriggeringTemplateResolver`; the Run boots from the cell base meanwhile) and on `onSetupFinished`; one build per environment at a time. `RequestingSetupHost` asks the setup request path for the setup after boot (`TemplateSetupRequester`). `runtime-fleet.module.ts` builds templates only when `FLEET_HOST_SEALER` and `FLEET_TEMPLATE_SETUP_REQUESTER` are provided; otherwise a Run host starts from its class's cell base (`boat.base`) and builds cold.
- A build starts from the environment's previous ready template (`TemplateStore.readyName` on the pool's cell base, and the snapshot still ready at the provider) and falls back to the cell base when there is none, it is of another base, or creating the host from it fails (`BoatSetupHost.boot`, retried with a client token of its own). `BuildTemplateResult.source` (`template` or `base`) goes into the `template.built` log. Only images, build cache and build state carry over: the cell adopts the previous catalog, and a setup claim never restores the previous bake's data (docs/runtime/host-providers.md §8.2). The replaced snapshot is deleted after the new template is promoted and the setup host created from it is destroyed, never before; a failed delete is logged `template.retire_failed`. A build that started from the template and failed stores its failure ending in `@template` (`TEMPLATE_SOURCED_FAILURE`); `TemplateStore.lastFailure` shows it to the next attempt, which starts from the cell base.
- A throw from any build step records the template row `failed` (`build_error`); the setup host is still destroyed.
- The cell base (`kodus-cell-<release>-<backend>`) is made outside runtime-fleet, once per cell release: the host recipe on a boat sandbox created with no env, `cell preflight` passing, never enrolled, saved; then named in the pool file and applied with `runtime-fleet apply`.

- `fleet-template-trigger.ts` `fleetTemplateTrigger`: the trigger as the fleet wires it. It reads the environment's own setup (`runtime_environment_setups`, by environment id); a template build's setup record (`runtime_template_setups`, by setup key) is only the bake probe's. Handing the trigger the template-setup store finds nothing and no template is ever built (Runs on boat then fail `environment_not_prepared`).
- `template-rebuild.ts` `TemplateRebuildPass`: the fleet cannot hear a setup finish (it runs in runtime-worker), so every minute, under the lock `fleet.template_rebuild`, it reads the active default-branch setups of the last 24 h (`setup-candidates-store.ts` `PgSetupCandidates`), skips template builds' own setups (`template:` key), and calls `onSetupFinished` for those whose fingerprint no template holds on an admitting boat perRun pool (`TemplateStore.holds`: ready, building, or failed in the last 30 min).
- A template that turns ready (`TemplateBuildTrigger`, a build that ended `ok` and was not `reused`) asks for a baseline suite run of the environment's main commit (`SuiteBaselineRequester`, `PgSuiteBaselineRequests` in `shared/persistence`), only when the setup record's recipe declares a `suite` whose `baseline` is not `false` and names the commit. A request that cannot be recorded is logged (`template.baseline_request_failed`) and never undoes the template. The fleet only records the request; the product turns the queued ones into `RuntimeSuiteRequested`.
- The seal waits for the bake: the setup claim is released once its bake is acked, minutes before the cell has exported and recorded the images, and a seal then stopped the cell mid-bake (dev, 2026-11-26: a template saved with an empty catalog, every host made from it built cold). The cell refuses `cell.seal` while a bake is in progress (`bake_running`) or a claim is live (`claim_live`); the hub client turns those into `seal_busy_<code>` and `HubHostSealer` asks again every 10 s for up to 30 minutes.
- A build's failure cause is a short code (`causeOf`): the hub client throws `seal_refused_<status>`, `connection_refused_<status>`, `hub_timeout`, `hub_unreachable`, `hub_bad_answer`; the sealer `seal_timeout`, or `seal_busy_timeout` when the cell stayed busy.

## Where new code goes
- A new reason to build a template goes in `template-rebuild.ts` or the trigger, not in the worker.

## Tests
- `build-template.spec.ts` and `boat-setup-host.spec.ts` (fakes); `template-rebuild.spec.ts` (fakes); `template-store.integration.spec.ts` (real Postgres; also the rebuild pass's SQL).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (11, tests apart): `bake-probe.ts`, `boat-setup-host.ts`, `build-template.ts`, `fleet-template-trigger.ts`, `hub-host-sealer.ts`, `pg-template-setup-requester.ts`, `setup-candidates-store.ts`, `template-name.ts`, `template-rebuild.ts`, `template-store.ts`, `template-trigger.ts`

Imports these Runtime modules:

- [`apps/runtime/src/fleet`](../AGENTS.md)
- [`apps/runtime/src/shared/persistence`](../../shared/persistence/AGENTS.md)
- [`libs/runtime/fleet`](../../../../../libs/runtime/fleet/AGENTS.md)
- [`libs/runtime/placement`](../../../../../libs/runtime/placement/AGENTS.md)
- [`libs/runtime/protocol`](../../../../../libs/runtime/protocol/AGENTS.md)
- [`libs/runtime/run`](../../../../../libs/runtime/run/AGENTS.md)
- [`libs/runtime/run/adapters`](../../../../../libs/runtime/run/adapters/AGENTS.md)

Imported by:

- [`apps/runtime/src/fleet`](../AGENTS.md)

<!-- module-map:end -->
