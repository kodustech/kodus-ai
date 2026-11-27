import { CLAIM_CONSUMERS, CLAIM_SIDES, CLAIM_STATES, CELL_OWNERS, BLOCKER_KINDS, RUN_TRIGGERS, VERDICTS } from '@libs/runtime/contracts/enums';
import { CELL_ISOLATIONS } from '@libs/runtime/contracts/isolation';
import { RUN_STATES } from '@libs/runtime/run/run-state';

import TAXONOMY_FILE from './taxonomy.json';

// The one telemetry vocabulary of the Kody Runtime (docs/runtime/observability.md
// part 2): attribute names, their closed values, and the metric catalog. The
// data lives in taxonomy.json, which the Go cell embeds a byte-identical copy
// of, so a name is decided once for TS and Go, spans, logs and metrics.

export type Cardinality = 'id' | 'tenant' | 'dimension';

export interface AttributeSpec {
    group: 'who' | 'what' | 'where' | 'why' | 'model';
    cardinality: Cardinality;
    type: 'string' | 'int';
    meaning: string;
    /** Older field names a log line may still carry; the logger writes the canonical key instead. */
    aliases?: string[];
}

export type Instrument = 'counter' | 'histogram' | 'gauge' | 'updowncounter';

export interface MetricSpec {
    producer: string;
    instrument: Instrument;
    unit: string;
    /** Attribute keys or metric-local label names (TAXONOMY.metricLocalLabels). */
    labels: string[];
    /** A histogram's bucket boundaries, in its unit: the OTel default (0..10 000) cannot tell a 3-minute boot from a 30-minute one. */
    buckets?: number[];
    meaning: string;
}

interface TaxonomyFile {
    version: number;
    attributes: Record<string, AttributeSpec>;
    metricLocalLabels: Record<string, string>;
    metrics: Record<string, MetricSpec>;
}

export const TAXONOMY = TAXONOMY_FILE as TaxonomyFile;

/** The attribute keys, by what they name. Use these, never a string literal. */
export const ATTR = {
    organizationId: 'kodus.organization.id',
    teamId: 'kodus.team.id',
    repositoryId: 'kodus.repository.id',
    prNumber: 'vcs.change.id',
    correlationId: 'kodus.correlation.id',
    environmentId: 'kodus.runtime.environment.id',
    runId: 'kodus.runtime.run.id',
    runAttempt: 'kodus.runtime.run.attempt',
    runTrigger: 'kodus.runtime.run.trigger',
    runState: 'kodus.runtime.run.state',
    runPhase: 'kodus.runtime.run.phase',
    setupKey: 'kodus.runtime.setup.key',
    setupState: 'kodus.runtime.setup.state',
    setupOutcome: 'kodus.runtime.setup.outcome',
    recipeOrigin: 'kodus.runtime.recipe.origin',
    claimId: 'kodus.runtime.claim.id',
    claimSide: 'kodus.runtime.claim.side',
    claimConsumer: 'kodus.runtime.claim.consumer',
    claimState: 'kodus.runtime.claim.state',
    claimReason: 'kodus.runtime.claim.reason',
    claimStart: 'kodus.runtime.claim.start',
    stepId: 'kodus.runtime.step.id',
    stepKind: 'kodus.runtime.step.kind',
    stepOutcome: 'kodus.runtime.step.outcome',
    stepReason: 'kodus.runtime.step.reason',
    machineId: 'kodus.runtime.machine.id',
    secretId: 'kodus.runtime.secret.id',
    cellId: 'kodus.runtime.cell.id',
    cellOwner: 'kodus.runtime.cell.owner',
    isolationLevel: 'kodus.runtime.isolation.level',
    isolationBackend: 'kodus.runtime.isolation.backend',
    driver: 'kodus.runtime.driver',
    hubReplicaId: 'kodus.runtime.hub.replica.id',
    bootPhase: 'kodus.runtime.boot.phase',
    exportStep: 'kodus.runtime.build.export_step',
    egressPhase: 'kodus.runtime.egress.phase',
    blockerKind: 'kodus.runtime.blocker.kind',
    blockerSignature: 'kodus.runtime.blocker.signature',
    verdict: 'kodus.runtime.verdict',
    probeVerdict: 'kodus.runtime.probe.verdict',
    stuckSubject: 'kodus.runtime.stuck.subject',
    stuckState: 'kodus.runtime.stuck.state',
    stuckAgeMs: 'kodus.runtime.stuck.age_ms',
    stuckBoundMs: 'kodus.runtime.stuck.bound_ms',
    llmTask: 'kodus.llm.task',
    model: 'gen_ai.request.model',
    tokenType: 'gen_ai.token.type',
    serverAddress: 'server.address',
    errorType: 'error.type',
    errorCode: 'kodus.runtime.error.code',
    hubDurationMs: 'kodus.runtime.hub.duration_ms',
    cellDurationMs: 'kodus.runtime.cell.duration_ms',
} as const;
export type AttrKey = (typeof ATTR)[keyof typeof ATTR];

export const RUN_VERDICTS = ['no_regressions', 'regression', 'partly_tested', 'could_not_boot', 'nothing_to_test'] as const;
export const SETUP_STATES = ['setting_up', 'active', 'blocked'] as const;
export const SETUP_OUTCOMES = ['active', 'blocked'] as const;
export const RECIPE_ORIGINS = ['committed', 'inferred', 'authored', 'submitted', 'none'] as const;
export const CLAIM_STARTS = ['cold', 'pool', 'bake', 'template', 'session'] as const;
export const BOOT_PHASE_VALUES = ['prepare', 'boot', 'build', 'up', 'seed', 'ready', 'snapshot'] as const;
/** The export step's parts as the cell names them (internal/buildprogress exportPhases) → their label value. */
export const EXPORT_STEPS: Readonly<Record<string, string>> = {
    'export layers': 'export_layers',
    'send tarball': 'send_tarball',
    'push layers': 'push_layers',
    'export cache': 'export_cache',
    'unpack image': 'unpack_image',
};
export const STEP_KINDS = ['probe.run', 'exec', 'browser.explore', 'machine.reset', 'upload', 'sandbox.op', 'claim.snapshot'] as const;
export const STEP_OUTCOMES = ['ok', 'timeout', 'refused', 'transport_lost', 'security_violation'] as const;
export const METRIC_DRIVERS = ['local-docker', 'docker-gvisor', 'aws-ec2', 'k8s-sandbox', 'fake'] as const;
export const ISOLATION_BACKENDS = ['gvisor', 'firecracker'] as const;
export const LLM_TASKS = ['recipe_author', 'planner', 'run_agent', 'intent', 'setup_learn', 'other'] as const;
export const TOKEN_TYPES = ['input', 'output'] as const;
export const RUN_PHASES = ['boot', 'agent', 'replay', 'intent'] as const;
export const STUCK_SUBJECTS = ['run', 'setup', 'claim', 'sandbox', 'admission', 'workflow', 'cell', 'setup_queue'] as const;
/** The states the hang detector reports (libs/runtime/health/stuck.ts STUCK_BOUNDS; its spec keeps them equal). */
export const STUCK_STATES = [
    'queued', 'awaiting_approval', 'booting', 'testing', 'setting_up', 'no_progress',
    'pending', 'bound', 'held', 'blocked', 'failed', 'compromised',
    'waiting', 'owned', 'reserved', 'dispatched',
    'ENQUEUED', 'PENDING runtimeRun', 'PENDING runtimeEnvironmentSetup', 'PENDING runtimeRunStop', 'PENDING runtimeForkGate', 'PENDING runtimeAdmission',
    'connected_silent',
] as const;
export const ERROR_TYPES = ['timeout', 'cancelled', 'network', 'permission_denied', 'invalid_input', 'unexpected'] as const;
/** The Node error codes failure.ts keeps (CODES). */
export const ERROR_CODES = ['ETIMEDOUT', 'ECONNABORTED', 'ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EACCES', 'EPERM', 'ERR_INVALID_ARG_TYPE'] as const;
/** egress.blocked phase values the protocol carries (messages.ts). */
export const EGRESS_PHASES = ['build', 'test'] as const;
/** The claim reasons (CLAIM_REASONS of the hub store, mirrored: the hub's own test keeps them equal). */
export const CLAIM_REASON_VALUES = [
    'acquired', 'reacquired', 'ready', 'held_for_diagnosis', 'acquire_unanswered', 'cell_refused', 'cell_blocked',
    'not_ready', 'boot_failed', 'security_violation', 'released', 'cell_revoked',
] as const;

/** Closed values of each dimension attribute; a value outside becomes "other". */
export const DIMENSION_VALUES: Readonly<Partial<Record<AttrKey, readonly string[]>>> = {
    [ATTR.runTrigger]: RUN_TRIGGERS,
    [ATTR.runState]: RUN_STATES,
    [ATTR.runPhase]: RUN_PHASES,
    [ATTR.setupState]: SETUP_STATES,
    [ATTR.setupOutcome]: SETUP_OUTCOMES,
    [ATTR.recipeOrigin]: RECIPE_ORIGINS,
    [ATTR.claimSide]: CLAIM_SIDES,
    [ATTR.claimConsumer]: CLAIM_CONSUMERS,
    [ATTR.claimState]: CLAIM_STATES,
    [ATTR.claimReason]: CLAIM_REASON_VALUES,
    [ATTR.claimStart]: CLAIM_STARTS,
    [ATTR.stepKind]: STEP_KINDS,
    [ATTR.stepOutcome]: STEP_OUTCOMES,
    [ATTR.cellOwner]: CELL_OWNERS,
    [ATTR.isolationLevel]: CELL_ISOLATIONS,
    [ATTR.isolationBackend]: ISOLATION_BACKENDS,
    [ATTR.driver]: METRIC_DRIVERS,
    [ATTR.bootPhase]: BOOT_PHASE_VALUES,
    [ATTR.exportStep]: Object.values(EXPORT_STEPS),
    [ATTR.egressPhase]: EGRESS_PHASES,
    [ATTR.blockerKind]: BLOCKER_KINDS,
    [ATTR.verdict]: RUN_VERDICTS,
    [ATTR.probeVerdict]: VERDICTS,
    [ATTR.stuckSubject]: STUCK_SUBJECTS,
    [ATTR.stuckState]: STUCK_STATES,
    [ATTR.llmTask]: LLM_TASKS,
    [ATTR.tokenType]: TOKEN_TYPES,
    [ATTR.errorType]: ERROR_TYPES,
    [ATTR.errorCode]: ERROR_CODES,
};

export const OTHER = 'other';

/** A dimension's value, or "other" when the code did not decide it (bounded cardinality). */
export function dimension(key: AttrKey, value: unknown): string {
    if (key === ATTR.blockerSignature) return blockerSignatureClass(value);
    const values = DIMENSION_VALUES[key];
    if (!values) return OTHER;
    return typeof value === 'string' && values.includes(value) ? value : OTHER;
}

/** An id's value when it has the shape of one (letters, digits, `._:@/-`, at most 128), else undefined. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
export const idValue = (value: unknown): string | undefined => (typeof value === 'string' && ID.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined);

/**
 * The signature classes the catalog decides, longest first. A blocker
 * signature carries repository text after its class (`missing_env:<NAME>`,
 * `external_service:<host>`, `resources:memory:<service>`): telemetry carries
 * the class only, the product's own records keep the full signature.
 */
export const BLOCKER_SIGNATURE_CLASSES = [
    // Classes with a repository-derived suffix: the catalog's (libs/runtime/blockers/catalog.ts)
    // and the setup's ready check (setup:not_ready:<service>:<port><path>). The class only.
    'external_service:platform_denied',
    'external_service:build_egress',
    'external_service:egress',
    'external_service:localhost',
    'external_service',
    'toolchain:lockfile_outdated',
    'toolchain:go_module_not_pinned',
    'platform:mirror_artifact_missing',
    'platform:not_listening',
    'resources:memory',
    'missing_env',
    'native_dep',
    'setup:not_ready',
    // Whole signatures set in code (the drift test reads every `signature: '...'` and `blockerErr(..., "...")`).
    'platform:go_checksum_db', 'toolchain:firebase_emulator_download', 'resources:disk', 'seed_data:schema', 'toolchain:go', 'toolchain:node', 'toolchain:python',
    'compose_refused:memory',
    'setup:no_recipe', 'setup:no_ref', 'setup:recipe_invalid',
    ...BLOCKER_KINDS.map((k) => `setup:${k}`),
    'setup_setting_up', 'setup_blocked',
    'admission_ticket_invalid', 'admission_ticket_required', 'authored_checks', 'authored_files_unsupported', 'authored_files',
    'backend_unavailable', 'boot_timeout', 'build_state_evicted', 'builder_failed', 'cell_disk_full', 'cell_lost', 'cell_unavailable', 'claim_keys', 'claim_network', 'claim_not_ready',
    'claim_ready_refused', 'claim_released', 'host_unavailable', 'compose_load', 'compose_refused', 'compose_up', 'create_observer',
    'create_workload', 'disk_capacity', 'disk_top_writer', 'egress_policy', 'environment_not_prepared', 'fake_image_pin_required', 'guest_agent', 'image_load',
    'image_too_large', 'isolation_unavailable', 'machine_minutes_exhausted', 'memory_unavailable', 'no_capacity', 'no_setup',
    'org_capacity', 'org_key', 'out_of_memory', 'recipe_capability_unsupported', 'recipe_invalid', 'recipe_needs_member',
    'preview_unsupported', 'recipe_needs_conflict', 'recipe_needs', 'repo_fetch', 'repo_refused', 'repo_source', 'repo_upload', 'restore_workload', 'snapshot_unsupported',
    'sandbox_unsupported', 'skip_bake_unsupported', 'suite_unsupported', 'suite_tokens_exhausted', 'tool_layers_unsupported', 'size_unavailable', 'sql_observer_configuration', 'sql_observer_unsupported',
    'sql_provision_failed', 'workdir', 'workspace_layout', 'workspace_primary_alias', 'workspace_token_missing',
    // A security_violation's signature is the alert kind (internal/agent/alerts.go, internal/egress/alerts.go).
    'credential_exfiltration', 'bait_exfiltration', 'placeholder_leak',
    // Admission refusals the worker turns into a setup or Run blocker (AdmissionReason, accept statuses).
    'no_cell', 'pair_too_large', 'owner_changed', 'ticket_expired', 'global_limit', 'org_limit', 'setup_limit',
    'deadline', 'attempt_limit', 'cancelled', 'unavailable', 'member_cleanup_pending', 'backlog_full', 'payload_too_large', 'expired',
];

const RECIPE_STEP_SIGNATURE = /^recipe_[a-z][a-z0-9_]{0,47}$/;

/** The class of a blocker signature (its catalog prefix), or "other". */
export function blockerSignatureClass(signature: unknown): string {
    if (typeof signature !== 'string') return OTHER;
    for (const c of BLOCKER_SIGNATURE_CLASSES) {
        if (signature === c || signature.startsWith(`${c}:`)) return c;
    }
    if (RECIPE_STEP_SIGNATURE.test(signature)) return signature;
    // setup:<ErrorName> (environment-setup.service.ts): a code name, kept as one class.
    return /^setup:[A-Za-z]+$/.test(signature) ? 'setup:error' : OTHER;
}

/** Older field names → their canonical key (the aliases of taxonomy.json). */
export const ATTRIBUTE_ALIASES: ReadonlyMap<string, string> = new Map(
    Object.entries(TAXONOMY.attributes).flatMap(([key, spec]) => (spec.aliases ?? []).map((alias) => [alias, key] as const)),
);

/** The canonical key of a field name: an alias becomes its attribute, anything else stays. */
export const canonicalKey = (key: string): string => ATTRIBUTE_ALIASES.get(key) ?? key;

/** The Prometheus name of an OTel metric as @opentelemetry/exporter-prometheus writes it. */
export function promMetricName(name: string): string {
    const spec = TAXONOMY.metrics[name];
    if (!spec || spec.producer.split(',').some((p) => ['cell', 'injector', 'reaper', 'egress'].includes(p))) return name;
    const base = name.replace(/[^a-zA-Z0-9_:]/g, '_');
    return spec.instrument === 'counter' && !base.endsWith('_total') ? `${base}_total` : base;
}

/** The Prometheus label name of an attribute key (dots become underscores). */
export const promLabel = (key: string): string => key.replace(/[^a-zA-Z0-9_]/g, '_');

/**
 * The boot phase names the cell itself chooses (internal/buildprogress,
 * drivers/dockergvisor/up.go). Every other phase is named from a Dockerfile
 * line (a RUN's command, a COPY's arguments, a base image): repository text.
 */
export const CELL_PHASE_NAMES: ReadonlySet<string> = new Set([
    'export layers', 'send tarball', 'push layers', 'export cache', 'unpack image',
    'send context', 'import cache', 'compose down', 'compose up', 'first healthy',
]);

/** A boot phase's name as telemetry may carry it: the cell's own names, else "build step". */
export const telemetryPhaseName = (name: string): string => (CELL_PHASE_NAMES.has(name) ? name : 'build step');

const WORD = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A claim's state detail (`kind/signature`, a nack code, why a wait ended)
 * as a log may carry it: each part a closed word, a signature reduced to its
 * class. The full detail stays on the claim row.
 */
export const telemetryDetail = (detail: string): string =>
    detail
        .split('/')
        .slice(0, 2)
        .map((part) => (WORD.test(part) ? part : blockerSignatureClass(part)))
        .join('/');
