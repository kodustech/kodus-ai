/**
 * Task references inside a pull request description.
 *
 * Generating a PR summary with `behaviourForExistingDescription: 'replace'`
 * overwrites the whole body, which silently takes the author's `Closes #N`
 * with it. That costs more than the text: the provider stops linking the issue
 * to the PR (no auto-close on merge), and every later run that mines the
 * description for a task — business-logic validation, `@kody -v business-logic`
 * — has nothing left to find.
 *
 * These are the lines worth carrying over into the replacement.
 */

/** Longer than this is prose that mentions an issue, not a reference line. */
const MAX_REFERENCE_LINE_LENGTH = 200;

/** Bounded so a description cannot come back wholesale through this door. */
const MAX_REFERENCE_LINES = 10;

const KODY_SUMMARY_BLOCK =
    /<!-- kody-pr-summary:start -->[\s\S]*?<!-- kody-pr-summary:end -->/g;

const REFERENCE_PATTERNS = [
    /(?:^|[\s(])#\d+\b/,
    /\b[A-Z][A-Z0-9_]+-\d+\b/,
    /https?:\/\/\S*\/(?:issues?|browse|tickets?|tasks?|work-items)\/\S+/i,
];

/**
 * Reference-carrying lines from `body`, in their original order and wording.
 * Lines inside a previous Kody summary are ignored — that text is Kody's own,
 * and preserving it would compound on every run.
 */
export function extractTaskReferenceLines(body: string): string[] {
    if (typeof body !== 'string' || !body.trim()) {
        return [];
    }

    const authored = body.replace(KODY_SUMMARY_BLOCK, '');
    const seen = new Set<string>();
    const preserved: string[] = [];

    for (const rawLine of authored.split('\n')) {
        const line = rawLine.trim();

        if (
            !line ||
            line.length > MAX_REFERENCE_LINE_LENGTH ||
            seen.has(line) ||
            !REFERENCE_PATTERNS.some((pattern) => pattern.test(line))
        ) {
            continue;
        }

        seen.add(line);
        preserved.push(line);

        if (preserved.length === MAX_REFERENCE_LINES) {
            break;
        }
    }

    return preserved;
}
