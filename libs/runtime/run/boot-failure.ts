import { type BlockerInput, classifyBlocker, deniedEgressBundle, matchedBlockerLine } from '@libs/runtime/blockers/catalog';
import { BLOCKER_KINDS, type BlockerKind } from '@libs/runtime/contracts/enums';

// Why one side's machine did not boot, as proof a developer reads without
// opening the cell: the catalog's cause (kind, signature, title), the log line
// it read the cause from, and the tail of the build or compose output. The
// cell already redacted the text with the claim's redactor (S-51); `clean`
// runs again here (token patterns, and the Run's canaries on the worker), per
// line and before any cut, so a cut never splits a secret out of a pattern.

export const BOOT_FAILURE_LINE_MAX = 300;
export const BOOT_FAILURE_TAIL_LINES = 40;
export const BOOT_FAILURE_TITLE_MAX = 200;
export const BOOT_FAILURE_SIGNATURE_MAX = 256;

/** RuntimeRunProjection.bootFailure: the first blocker of the side whose boot decided the Run. */
export interface RunBootFailure {
    side: 'base' | 'pr';
    kind: BlockerKind;
    /** The catalog's signature (Environment Health groups by it), e.g. `platform:go_checksum_db`. */
    signature: string;
    /** The catalog's title: a template, or the cell's own reason's first line when no rule knew it. */
    title: string;
    /** The line the catalog matched, else the last line that reads as an error. At most 300 characters. */
    errorLine?: string;
    /** The last lines of the build or compose output, oldest first: at most 40, each at most 300 characters. */
    logTail: string[];
    /** When the hub answered the claim as failed. */
    at: string;
    /** The repository of a multi-repository environment the blocker is about (its alias); absent: the environment's own, or not known. */
    alias?: string;
    /**
     * A PR side the egress proxy stopped: the hosts it denied that side and
     * not the base, from the hub's record of the proxy's refusals (never the
     * PR's output). The Run is partly tested, never a regression, and its
     * check asks to approve them (owner decision D7 of 2026-11-18).
     */
    deniedHosts?: string[];
}

/** The cell's name of the bundle entry that holds the boot's own output (apps/runtime-cell/internal/agent/bundle.go). */
const BOOT_OUTPUT_SERVICE = 'boot output';

// Terminal escapes (BuildKit colours, cursor moves) and the other control characters but tab.
// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const ERROR_LINE = /\bERROR\b|error:/i;

/** One line, cut in the middle: the head names the step, the tail usually holds the error. */
export function clipMiddle(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = Math.ceil((max - 1) / 2);
    return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

const oneLine = (s: string) => s.replace(CONTROL, '').replace(/\s+$/, '');

/**
 * The tail and the error line of a failed boot, cleaned and bounded. The
 * whole reason is cleaned before it is split (a secret may span lines), each
 * bundle line on its own (the cell sends them so). Shared by the hub's
 * blocker row and the Run projection.
 */
export function bootOutputOf(b: Pick<BlockerInput, 'message' | 'bundle'>, clean: (text: string) => string): { errorLine?: string; logTail: string[] } {
    const message = clean(b.message ?? '');
    const services = (b.bundle?.services ?? []).map((s) => ({ ...s, logTail: s.logTail.map(clean) }));
    // The bundle's boot output when a setup claim sent one, else the cell's reason (a Run claim has no bundle).
    const boot = services.find((s) => s.name === BOOT_OUTPUT_SERVICE)?.logTail;
    const lines = (boot?.length ? boot : message.split(/\r?\n/)).map(oneLine).filter((l) => l.trim().length > 0);
    const matched = matchedBlockerLine({ message, ...(b.bundle ? { bundle: { ...b.bundle, services } } : {}) });
    const errorLine = (matched !== undefined ? oneLine(matched) : [...lines].reverse().find((l) => ERROR_LINE.test(l)))?.trim();
    const bounded = (l: string) => clipMiddle(l, BOOT_FAILURE_LINE_MAX);
    return {
        ...(errorLine ? { errorLine: bounded(errorLine) } : {}),
        logTail: lines.slice(-BOOT_FAILURE_TAIL_LINES).map(bounded),
    };
}

/** Why a fork's PR side could not reach a host: approvals and secrets never reach a fork's code (D7). */
export const FORK_EGRESS_TITLE = "A fork's code gets no approved host and no secret";

/** The boot failure detail of one side, from the first blocker its cell reported. */
export function bootFailureOf(args: { side: 'base' | 'pr'; blocker: BlockerInput; at: string; clean: (text: string) => string; alias?: string; fork?: boolean }): RunBootFailure {
    const { blocker, clean } = args;
    const c = classifyBlocker({ kind: blocker.kind, signature: blocker.signature, message: blocker.message, ...(blocker.bundle ? { bundle: blocker.bundle } : {}) });
    const kind: BlockerKind = (BLOCKER_KINDS as readonly string[]).includes(c.kind) ? (c.kind as BlockerKind) : 'unknown';
    const firstLine = (s: string) => oneLine(clean(s).split(/\r?\n/)[0] ?? '').trim();
    return {
        side: args.side,
        kind,
        signature: clipMiddle(firstLine(c.signature) || 'unknown', BOOT_FAILURE_SIGNATURE_MAX),
        // D7: the PR side of a fork never gets the environment's approved hosts nor the org's secrets, so a host
        // only an approval opens stops it, and the title says why. A boot the proxy's record shows it stopped is
        // partly tested and asks to approve the host (deniedHostsBootFailureOf), never a regression.
        title: clipMiddle(
            (args.fork && args.side === 'pr' && kind === 'external_service' ? `${FORK_EGRESS_TITLE}: ${firstLine(c.title)}` : firstLine(c.title)) || 'The machine did not boot',
            BOOT_FAILURE_TITLE_MAX,
        ),
        ...bootOutputOf(blocker, clean),
        at: args.at,
        ...(args.alias ? { alias: args.alias } : {}),
    };
}

/**
 * The input the catalog reads for a PR boot the egress proxy stopped: the
 * hosts it denied that side and not the base (the hub's record, never the
 * PR's output), so the card is the "approve this host" one. The Run page,
 * Environment Health and the environment's blocker cards all read it so.
 */
export function deniedHostsBlockerInput(hosts: readonly string[], at: string): BlockerInput {
    return {
        kind: 'external_service',
        signature: 'external_service:egress',
        message: hosts.map((h) => `outbound request to ${h} blocked`).join('\n'),
        bundle: deniedEgressBundle(hosts, at),
    };
}

/**
 * The boot failure of a PR side the egress proxy stopped: the "approve this
 * host" card's kind, signature and title, the hosts, and the PR's own error
 * line and tail as the side's boot output (shown, never what decides).
 */
export function deniedHostsBootFailureOf(args: { blocker: BlockerInput; hosts: string[]; at: string; clean: (text: string) => string; alias?: string; fork?: boolean }): RunBootFailure {
    const c = classifyBlocker(deniedHostsBlockerInput(args.hosts, args.at));
    const kind: BlockerKind = (BLOCKER_KINDS as readonly string[]).includes(c.kind) ? (c.kind as BlockerKind) : 'external_service';
    const title = c.title || `The machine was denied ${args.hosts[0]}`;
    return {
        side: 'pr',
        kind,
        signature: clipMiddle(c.signature, BOOT_FAILURE_SIGNATURE_MAX),
        title: clipMiddle(args.fork ? `${FORK_EGRESS_TITLE}: ${title}` : title, BOOT_FAILURE_TITLE_MAX),
        ...bootOutputOf(args.blocker, args.clean),
        at: args.at,
        ...(args.alias ? { alias: args.alias } : {}),
        deniedHosts: args.hosts,
    };
}
