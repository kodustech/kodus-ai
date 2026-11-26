import type { BlockerEvidence, BlockerInput, ClassifiedBlocker } from './catalog';

// The evidence a developer's coding agent reads to fix a recipe (env_blockers).
// A card's own evidence is one line, enough for a screen; a failed build or boot
// is fixed from what the step printed, so the agent gets the failing step and
// the lines of its output instead.

/** The most lines of a failed step's output the evidence carries: its first errors that scrolled out, its last 40 lines, BuildKit's own. */
export const FULL_EVIDENCE_LINES = 49;
/** The name of the failure bundle's entry that holds the failed boot's own output (apps/runtime-cell/internal/agent/bundle.go bootOutputService). */
const BOOT_OUTPUT = 'boot output';
const MAX_LINE = 2_048;
/** How the cell opens a failed build's error (internal/drivers/dockergvisor/build.go buildFailure): the step, then its lines indented by two spaces. */
const STEP_LEAD = /^step (.+) failed:$/;

const clean = (lines: string[]) =>
    lines
        .map((l) => l.trimEnd().slice(0, MAX_LINE))
        .filter((l) => l.trim().length > 0);

/** The lines of the failed step the cell named at the start of the boot's output, with its name; none when the output has no such lead. */
function stepLead(lines: string[]): { step: string; lines: string[] } | null {
    const at = lines.findIndex((l) => STEP_LEAD.test(l));
    if (at < 0) return null;
    const step = STEP_LEAD.exec(lines[at])![1].slice(0, 200);
    const out: string[] = [];
    for (const l of lines.slice(at + 1)) {
        if (!l.startsWith('  ')) break;
        out.push(l.trim());
    }
    return out.length ? { step, lines: out.slice(-FULL_EVIDENCE_LINES) } : { step, lines: [] };
}

/**
 * The card's evidence for a project that failed to build or start (signature compose_up), with the
 * failing step and the output that says why: the step's own lines when the cell named the step, else the
 * last lines of the service the card quotes, else of the boot's output (the bundle's, or the message when
 * there is none). The card's own line stays first when it is not among them, unless the step's own lines are the evidence. Any other blocker keeps
 * its evidence: it is a Kodus or a policy line the card quotes whole.
 */
export function fullEvidenceOf(input: BlockerInput, card: ClassifiedBlocker): BlockerEvidence {
    if (input.signature !== 'compose_up') return card.evidence;
    const services = input.bundle?.services ?? [];
    const bootOutput = services.find((s) => s.name === BOOT_OUTPUT);
    const boot = clean(bootOutput?.logTail ?? input.message.split('\n'));
    const lead = stepLead(boot) ?? stepLead(clean(input.message.split('\n')));
    const quoted = card.evidence.service && card.evidence.service !== BOOT_OUTPUT ? services.find((s) => s.name === card.evidence.service) : undefined;
    const source = quoted ? clean(quoted.logTail) : lead?.lines.length ? lead.lines : boot;
    const tail = source.slice(-FULL_EVIDENCE_LINES);
    const first = card.evidence.lines[0];
    const known = first === undefined || (!quoted && !!lead?.lines.length) || tail.some((l) => l.includes(first.slice(0, 120)));
    return {
        ...card.evidence,
        lines: known ? tail : [first, ...tail].slice(0, FULL_EVIDENCE_LINES),
        ...(lead ? { step: lead.step } : {}),
    };
}
