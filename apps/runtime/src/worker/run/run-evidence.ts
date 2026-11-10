import { randomBytes } from 'crypto';

import {
    BROWSER_ROUND_GRACE_MS,
    EVIDENCE_MAX_SCREENSHOTS,
    EVIDENCE_MAX_TTL_SECONDS,
    evidenceKey,
    EVIDENCE_UPLOAD_MAX_TTL_SECONDS,
    evidenceUploadLimit,
    type EvidenceUploadType,
    signEvidenceUrl,
    signUploadGrant,
} from '@libs/runtime/api/domain/evidence';
import type { EnvError, StepResult } from '@libs/runtime/environment';
import type { EvidenceRef, Probe } from '@libs/runtime/probe';
import type { BaselineScreenshot, EvidenceRequest } from '@libs/runtime/protocol';
import type { ExploredCommand } from '@libs/runtime/run';
import { redactPatterns } from '@libs/runtime/redaction';

import type { EvidenceStore } from '../../shared/file-evidence-store';
import type { EvidencePresigner } from '../../shared/s3-evidence-store';
import { type Canary, containsCanary, redactCanaries } from '../canary/canary';

// A Run step's output evidence (§8): one JSON object per step at
// {orgId}/{runId}/{side}/{stepId}/output, which the Run page opens by the
// step's id. Written from inside the step that ran, so a resumed workflow
// does not write it twice. A failed write never fails the step: it goes to
// onError, which logs and counts it.

/** Where a Run's evidence goes, and who hears that a write failed. */
export interface RunEvidence {
    organizationId: string;
    store: Pick<EvidenceStore, 'put'> & Partial<Pick<EvidenceStore, 'get' | 'takeUpload'>>;
    onError?: (e: unknown) => void;
    /** Where cells upload their artifacts with grants (EVIDENCE-CAPTURE-DESIGN); absent: no grant is signed. */
    uploads?: EvidenceUploads;
}

/** Where a cell uploads: the evidence server (HMAC grants) or the S3 bucket (presigned URLs). */
export type EvidenceUploads = EvidenceServerUploads | PresignedEvidenceUploads;

/** The evidence server as a cell reaches it, and the secret its grants are signed with. */
export interface EvidenceServerUploads {
    /** RUNTIME_EVIDENCE_UPLOAD_URL. */
    baseUrl: string;
    /** RUNTIME_EVIDENCE_SIGNING_SECRET. */
    secret: string;
    now?: () => Date;
}

/** RUNTIME_EVIDENCE_STORE=s3: grants are presigned PUTs to the bucket's staging key, reads presigned GETs. */
export interface PresignedEvidenceUploads {
    presigner: EvidencePresigner;
    now?: () => Date;
}

/**
 * The text artifacts a cell uploads: the worker reads them back for canaries (ADR-043) before anyone can open them.
 * The HAR is JSON; the cell stores the trace uncompressed (internal/browser), so a canary in it reads as text too.
 */
const TEXT_ARTIFACTS: ReadonlySet<EvidenceUploadType> = new Set(['logs', 'db', 'cast', 'har', 'trace']);
/** Binary containers whose text is checked byte for byte (latin1), so a rewrite never mangles the rest. */
const BYTE_ARTIFACTS: ReadonlySet<EvidenceUploadType> = new Set(['trace']);

/** Lean retains every screenshot/diff required by the existing visual proof. */
export const BROWSER_LEAN_UPLOAD_TYPES: readonly EvidenceUploadType[] = [
    ...Array.from({ length: EVIDENCE_MAX_SCREENSHOTS }, (_, i) => `screenshot-${i}` as EvidenceUploadType),
    ...Array.from({ length: EVIDENCE_MAX_SCREENSHOTS }, (_, i) => `pixeldiff-${i}` as EvidenceUploadType),
];

/** Full remains the default for existing probes and clients (ADR-071). */
export const BROWSER_UPLOAD_TYPES: readonly EvidenceUploadType[] = [
    ...BROWSER_LEAN_UPLOAD_TYPES,
    'video',
    'trace',
    'har',
];

/** The baseline round of a browser probe (main's first healthy one): its step and the screenshots it uploaded, by the step that took each. */
export interface BrowserBaseline {
    stepId: string;
    shots: Array<{ step: number; screenshot: number }>;
}

/**
 * The evidence request of one step: what to capture and, when uploads are
 * configured, one grant per artifact, bound to this step's key and living
 * the step's timeout plus two minutes (at most 15). With the browser
 * capture, the grants of the runner's artifacts and, past the baseline
 * round, a read URL of each baseline screenshot the cell diffs against.
 * The hub trims it to what the cell named in its hello.
 */
export function evidenceRequestOf(
    ev: RunEvidence | undefined,
    at: { runId: string; side: 'base' | 'pr'; stepId: string },
    capture: EvidenceRequest['capture'],
    timeoutMs: number,
    baseline?: BrowserBaseline,
    browserEvidence: Probe['evidence'] = 'full',
): EvidenceRequest {
    const browserTypes = browserEvidence === 'lean' ? BROWSER_LEAN_UPLOAD_TYPES : BROWSER_UPLOAD_TYPES;
    const uploadable: EvidenceUploadType[] = capture.flatMap((c): EvidenceUploadType[] => (c === 'logs' || c === 'db' || c === 'cast' ? [c] : c === 'browser' ? [...browserTypes] : []));
    if (!ev?.uploads || uploadable.length === 0) return { capture };
    const up = ev.uploads;
    const browser = capture.includes('browser');
    const ttlSeconds = Math.min(EVIDENCE_UPLOAD_MAX_TTL_SECONDS, Math.ceil((timeoutMs + (browser ? BROWSER_ROUND_GRACE_MS : 0)) / 1000) + 120);
    try {
        const shots = browser && baseline ? baselineOf(ev, up, at.runId, baseline) : [];
        const uploads = uploadable.map((type) =>
            'presigner' in up
                ? up.presigner.uploadGrant({ organizationId: ev.organizationId, runId: at.runId, side: at.side, stepId: at.stepId, type, ttlSeconds, now: up.now?.() })
                : signUploadGrant({
                      baseUrl: up.baseUrl,
                      organizationId: ev.organizationId,
                      runId: at.runId,
                      side: at.side,
                      stepId: at.stepId,
                      type,
                      secret: up.secret,
                      ttlSeconds,
                      nonce: randomBytes(18).toString('base64url'),
                      now: up.now?.(),
                  }),
        );
        return { capture, uploads, ...(shots.length ? { baseline: shots } : {}) };
    } catch (e) {
        ev.onError?.(e);
        return { capture };
    }
}

/**
 * A read URL (at most 5 minutes, §7) of each baseline screenshot, on the
 * evidence server as the cell reaches it: the cell reads them right after
 * its own round, which the hub bounds well under that.
 */
function baselineOf(ev: RunEvidence, up: EvidenceUploads, runId: string, baseline: BrowserBaseline): BaselineScreenshot[] {
    return baseline.shots.slice(0, EVIDENCE_MAX_SCREENSHOTS).map((s) => {
        const key = evidenceKey({ organizationId: ev.organizationId, runId, side: 'base', stepId: baseline.stepId, type: `screenshot-${s.screenshot}` });
        return {
            step: s.step,
            screenshot: s.screenshot,
            url:
                'presigner' in up
                    ? up.presigner.readUrl(key, EVIDENCE_MAX_TTL_SECONDS, up.now?.())
                    : signEvidenceUrl({ baseUrl: up.baseUrl, key, secret: up.secret, ttlSeconds: EVIDENCE_MAX_TTL_SECONDS, now: up.now?.() }).url,
        };
    });
}

/**
 * The refs a cell reported, checked against the store: a text artifact with
 * a canary in it is overwritten with the canary redacted and the step halts
 * the Run (`leaked`), as a canary in the result does. A ref whose object the
 * store does not hold is dropped (the upload never landed). Without a store
 * that reads, the refs stay as reported.
 */
export async function checkUploadedRefs(
    ev: RunEvidence | undefined,
    at: { runId: string; side: 'base' | 'pr'; stepId: string },
    refs: EvidenceRef[] | undefined,
    canaries: Canary[] = [],
): Promise<{ refs: EvidenceRef[]; leaked: boolean }> {
    if (!refs?.length) return { refs: [], leaked: false };
    if (ev?.store.takeUpload) return takeUploadedRefs(ev, at, refs, canaries);
    if (!ev?.store.get) return { refs, leaked: false };
    const kept: EvidenceRef[] = [];
    let leaked = false;
    for (const ref of refs) {
        try {
            const key = evidenceKey({ organizationId: ev.organizationId, runId: at.runId, side: at.side, stepId: at.stepId, type: ref.type });
            const obj = await ev.store.get(key);
            if (!obj) continue;
            if (TEXT_ARTIFACTS.has(ref.type) && canaries.length) {
                const encoding = BYTE_ARTIFACTS.has(ref.type) ? 'latin1' : 'utf8';
                const text = obj.body.toString(encoding);
                if (containsCanary(text, canaries)) {
                    leaked = true;
                    await ev.store.put(key, Buffer.from(redactCanaries(text, canaries), encoding), obj.contentType);
                }
            }
            kept.push(ref);
        } catch (e) {
            ev.onError?.(e);
        }
    }
    return { refs: kept, leaked };
}

/**
 * The same check where cells upload beside the evidence key (S3): each upload
 * is taken only within its type's content type and bytes, a text one is read
 * for canaries, and it becomes the evidence key's object (redacted when it
 * leaked) only then. A ref whose upload is missing or out of bounds is dropped.
 */
async function takeUploadedRefs(
    ev: RunEvidence,
    at: { runId: string; side: 'base' | 'pr'; stepId: string },
    refs: EvidenceRef[],
    canaries: Canary[],
): Promise<{ refs: EvidenceRef[]; leaked: boolean }> {
    const kept: EvidenceRef[] = [];
    let leaked = false;
    for (const ref of refs) {
        try {
            const key = evidenceKey({ organizationId: ev.organizationId, runId: at.runId, side: at.side, stepId: at.stepId, type: ref.type });
            const read = TEXT_ARTIFACTS.has(ref.type) && canaries.length > 0;
            const up = await ev.store.takeUpload!(key, evidenceUploadLimit(ref.type), { read });
            if (!up) continue;
            if (up.redacted) leaked = true;
            let replacement: Buffer | undefined;
            if (read && up.body) {
                const encoding = BYTE_ARTIFACTS.has(ref.type) ? 'latin1' : 'utf8';
                const text = up.body.toString(encoding);
                if (containsCanary(text, canaries)) {
                    leaked = true;
                    replacement = Buffer.from(redactCanaries(text, canaries), encoding);
                }
            }
            await up.commit(replacement);
            kept.push(ref);
        } catch (e) {
            ev.onError?.(e);
        }
    }
    return { refs: kept, leaked };
}

/** Writes one step's output evidence. Never throws: a bad key or a failed write goes to onError. */
export async function putStepOutput(ev: RunEvidence, at: { runId: string; side: 'base' | 'pr'; stepId: string }, body: unknown): Promise<void> {
    try {
        const key = evidenceKey({ organizationId: ev.organizationId, runId: at.runId, side: at.side, stepId: at.stepId, type: 'output' });
        await ev.store.put(key, JSON.stringify(body, null, 2), 'application/json');
    } catch (e) {
        ev.onError?.(e);
    }
}

/** Why a step has no result, in words a developer reads on the Run page: the code and its facts, no internal id. */
export function envErrorEvidence(e: EnvError): { code: EnvError['code']; reason: string; vmHealth?: string; afterMs?: number } {
    switch (e.code) {
        case 'lease_expired':
            return { code: e.code, reason: "the claim's lease expired before the step ran" };
        case 'vm_unhealthy':
            return { code: e.code, reason: `the machine did not answer (${e.vmHealth})`, vmHealth: e.vmHealth };
        case 'cell_unavailable':
            return { code: e.code, reason: 'the cell that holds the machine was not connected' };
        case 'timeout':
            return { code: e.code, reason: `no answer after ${e.afterMs} ms`, afterMs: e.afterMs };
        case 'transport_lost':
            return { code: e.code, reason: 'the connection to the machine was lost during the step' };
        case 'security_violation':
            return { code: e.code, reason: "the cell saw this claim's code exfiltrate; the claim runs nothing more" };
    }
}

/** Text from the machine, as evidence: token patterns and canaries redacted, then cut to max characters. */
export function boundedText(text: string, max: number, canaries: Canary[] = []): { text: string; truncated: boolean; redactions: number } {
    const patterns = redactPatterns(text ?? '');
    const clean = redactCanaries(patterns.text, canaries);
    return { text: clean.slice(0, max), truncated: clean.length > max, redactions: patterns.count };
}

export const EXPLORED_COMMAND_MAX = 300;
export const EXPLORED_OUTPUT_MAX = 16_384;

/** One exploration command for the Run projection: what ran and how it ended, never its output. */
export function exploredCommand(index: number, stepId: string, command: string, r: StepResult | EnvError, canaries: Canary[] = []): ExploredCommand {
    const cmd = boundedText(command, EXPLORED_COMMAND_MAX, canaries).text;
    if ('code' in r) return { index, stepId, command: cmd, error: r.code, failed: true };
    return { index, stepId, command: cmd, exitCode: r.exitCode, durationMs: r.durationMs, failed: r.exitCode !== 0 || r.transport !== 'ok' };
}

/** One exploration command's output evidence: stdout and stderr redacted and bounded, or why it never ran. */
export function explorationEvidence(index: number, stepId: string, command: string, r: StepResult | EnvError, canaries: Canary[] = []) {
    const head = { kind: 'exploration' as const, index, stepId, command: boundedText(command, EXPLORED_COMMAND_MAX, canaries).text };
    if ('code' in r) return { ...head, error: envErrorEvidence(r) };
    const stdout = boundedText(r.stdout, EXPLORED_OUTPUT_MAX, canaries);
    const stderr = boundedText(r.stderr, EXPLORED_OUTPUT_MAX, canaries);
    return {
        ...head,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        stdout: stdout.text,
        stderr: stderr.text,
        // Cut by the cell (its output cap) or here.
        truncated: r.truncated || stdout.truncated || stderr.truncated,
        redactions: (r.redactions ?? 0) + stdout.redactions + stderr.redactions,
    };
}
