import type { EnvironmentRuntime } from '@libs/runtime/environment';
import type { RunProjectionStore, RunStreamEvent, RuntimePublishRequested } from '@libs/runtime/run';
import type { RuntimeMetrics } from '@libs/runtime/telemetry';

import type { EvidenceStore } from '../../shared/evidence/file-evidence-store';
import type { RuntimeAgent } from '../agent/runtime-agent';
import type { CanaryVault } from '../canary/canary';
import type { FindingIntentClassifier } from '../intent/intent-classifier';
import type { EvidenceUploads } from './run-evidence';

/** One durable step: DBOS.runStep in production, a direct call in unit tests. */
export type StepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** Events of the Run stream; the hub writes them (ADR-047). `key` makes a retried append a no-op. */
export interface RunEventSink {
    append(orgId: string, runId: string, event: RunStreamEvent, key?: string): Promise<void>;
}

/** RuntimePublishRequested to workflow.jobs.runtime_publish.queue (ADR-052). */
export interface PublishRequester {
    request(msg: RuntimePublishRequested): Promise<void>;
}

/**
 * The claims of a Run, as the hub recorded them (read-only: the hub is the
 * only writer of runtime_claims), so cancel, timeout and the reaper can release them.
 */
export interface RunClaims {
    /** Claims of the Run not yet released. */
    forRun(runId: string): Promise<{ claimId: string; side: string }[]>;
    /** Outbound requests the proxy denied for these claims during the test. */
    egressBlocked(claimIds: string[]): Promise<{ host: string; port: number; phase: string }[]>;
    /** Security violations the cell reported on these claims (the hub records them): side and alert kind. */
    securityViolations(claimIds: string[]): Promise<{ claimId: string; side: string; signature: string }[]>;
}

/** @deprecated the old name of RunClaims. */
export type ClaimLedger = RunClaims;

/** Ends a claim through the hub (no Run context needed: the reaper uses it too). */
export interface ClaimReleaser {
    release(ref: { claimId: string; organizationId: string; runId?: string | null }, correlationId?: string): Promise<void>;
}

/** A Run's claims kept leased until stop() (lease-keeper.ts). */
export interface LeaseHold {
    stop(): void;
}

/** Keeps claims leased (claim.renew) while their Run works; outside the DBOS journal. */
export interface ClaimLeases {
    keep(claimIds: string[]): LeaseHold;
}

/** Fork PRs wait for a maintainer, bound to the head SHA (ADR-030, ADR-057). */
/** What an approval delivers to the waiting gate: the approved head and, from the product, fresh sealed tokens. */
export interface ForkApprovalMessage {
    headSha: string;
    tokens?: { repoToken: string; prRepoToken?: string; runToken: string };
}

export interface ForkApprovals {
    has(runId: string, headSha: string): Promise<boolean>;
    /** Waits durably for an approval message; resolves with the approved head, or null on timeout. */
    wait(runId: string): Promise<ForkApprovalMessage | null>;
}

/**
 * The worker's structured log of a Run: `msg` is a dotted event name, the
 * fields ids and numbers. Never a token, repository content or model text.
 */
export type RunLogEvent = { msg: string } & Record<string, unknown>;

export interface RunLog {
    info(event: RunLogEvent): void;
    warn(event: RunLogEvent): void;
}

export interface RunDeps {
    step: StepRunner;
    env: EnvironmentRuntime;
    agent: RuntimeAgent;
    /** Runs apart from the agent, without its exploration context (§4). */
    intent: FindingIntentClassifier;
    /**
     * The Run's canaries (ADR-043): every claim.acquire hands them to the cell, which plants them
     * in the workload (claim.acquire canaries), and every boundary is checked for them.
     */
    canaries: CanaryVault;
    projection: RunProjectionStore;
    events: RunEventSink;
    publisher: PublishRequester;
    claims: RunClaims;
    metrics: RuntimeMetrics;
    now: () => Date;
    /** The pause between rounds of a claim waiting for room on a cell (ADR-070); a timer when absent. */
    sleep?: (ms: number) => Promise<void>;
    /** Read inside the acquire step so each DBOS step receives its own cancellation signal. */
    cancellationSignal?: () => AbortSignal | undefined;
    /** The evidence object store (RUNTIME_EVIDENCE_DIR); without it the Run keeps no evidence. */
    evidence?: Pick<EvidenceStore, 'put'> & Partial<Pick<EvidenceStore, 'get' | 'takeUpload'>>;
    /** Where cells upload a round's artifacts with grants; absent: the cell's artifacts read "not captured". */
    evidenceUploads?: EvidenceUploads;
    /** Renews the Run's claims while it works; absent: the claims keep the lease of their acquire. */
    leases?: ClaimLeases;
    /** Where a release that failed is reported (it is retried by the reaper). */
    onReleaseFailed?: (claimId: string, e: Error) => void;
    /** One line per phase and one canonical line at the end (run.phase, run.finished); absent: silent. */
    log?: RunLog;
}
