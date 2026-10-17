/**
 * code-review (domain) — the deterministic gate for convention findings.
 *
 * A convention finding claims the change breaks a rule from a team guide and
 * quotes that rule (`source.quote` from `source.file`). Before any model judges
 * it, the quote must exist in the guide as it stands on the PR's TARGET branch:
 * a quote the model paraphrased or invented is dropped here with reason
 * `quote-not-found`, and the guide section that holds a real quote is handed
 * to the convention verifier.
 *
 * An ast-grep match is its own proof: a finding that cites an ast-grep rule and
 * whose file the run's ast-grep calls actually matched skips both this gate and
 * the model verify. A finding that cites ast-grep without such a match is not
 * proven and fails this gate.
 */
import type {
    AgentTool,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';

/** Reads a guide file as it is on the PR's target branch. `null` when the
 *  file does not exist there (or cannot be read). */
export type GuideFileReader = (file: string) => Promise<string | null>;

export const QUOTE_NOT_FOUND = 'quote-not-found' as const;

/** Name of the structural-search tool whose matches count as proof. */
export const AST_GREP_TOOL_NAME = 'astGrep' as const;

/** `source.file` of a finding backed by an ast-grep rule: `ast-grep:<ruleId>`
 *  (or `<dir>/sgconfig.yml#<ruleId>`). */
export const AST_GREP_SOURCE_PREFIX = 'ast-grep:' as const;

/** A quote shorter than this (after normalization) matches too easily to
 *  prove anything ("use", "must"). */
export const MIN_QUOTE_LENGTH = 12;

/** Cap on the guide section handed to the convention verifier. */
const MAX_SECTION_CHARS = 6000;

export interface ConventionCheckPassed {
    finding: FinderSuggestion;
    /** The guide section that holds the quote (heading to next heading),
     *  capped — the convention verifier judges the finding against it. */
    sectionText: string;
}

export interface ConventionCheckRejected {
    finding: FinderSuggestion;
    reason: typeof QUOTE_NOT_FOUND;
    detail: string;
}

export interface ConventionCheckResult {
    passed: ConventionCheckPassed[];
    rejected: ConventionCheckRejected[];
}

/** Whitespace-normalized form used to compare a quote with its guide. Also
 *  folds typographic quotes and drops markdown emphasis/code marks, applied to
 *  BOTH sides, so `**must**` in the guide matches "must" in the quote. */
export function normalizeQuoteText(text: string): string {
    return (text ?? '')
        .normalize('NFKC')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[*`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The section of `content` that contains `quote`, or null when the quote is
 *  not in the file. Sections are split at markdown headings; a file without
 *  headings is one section. */
export function findQuoteSection(
    content: string,
    quote: string,
): string | null {
    const needle = normalizeQuoteText(quote);
    if (!needle || !normalizeQuoteText(content).includes(needle)) {
        return null;
    }
    const sections: string[] = [];
    let current: string[] = [];
    for (const line of content.split(/\r?\n/)) {
        if (/^#{1,6}\s/.test(line) && current.length > 0) {
            sections.push(current.join('\n'));
            current = [];
        }
        current.push(line);
    }
    sections.push(current.join('\n'));
    const hit = sections.find((s) => normalizeQuoteText(s).includes(needle));
    // The quote spans a heading boundary: the whole file holds it.
    const section = (hit ?? content).trim();
    return section.length > MAX_SECTION_CHARS
        ? section.slice(0, MAX_SECTION_CHARS)
        : section;
}

/** The ast-grep rule id a finding cites as its source, if any. */
export function astGrepRuleIdOf(finding: FinderSuggestion): string | null {
    const file = finding.source?.file?.trim() ?? '';
    if (file.startsWith(AST_GREP_SOURCE_PREFIX)) {
        return file.slice(AST_GREP_SOURCE_PREFIX.length).trim() || null;
    }
    const m = /(?:^|\/)sgconfig\.ya?ml#(.+)$/.exec(file);
    return m ? m[1].trim() || null : null;
}

/** Output of every successful ast-grep call made during one review — the
 *  proof a cited rule matched a file. Recorded at the tool itself, because a
 *  run's steps keep tool inputs, not outputs. */
export class AstGrepOutputLog {
    private readonly entries: string[] = [];

    record(output: string): void {
        if (output) this.entries.push(output);
    }

    get outputs(): readonly string[] {
        return this.entries;
    }
}

/** The same registry, with the ast-grep tool (when present) recording its
 *  successful outputs into `log`. Every other tool is untouched. */
export function recordAstGrepOutputs(
    registry: ToolRegistry,
    log: AstGrepOutputLog,
): ToolRegistry {
    if (!registry.get(AST_GREP_TOOL_NAME)) return registry;
    return new InMemoryToolRegistry(
        registry.list().map((tool): AgentTool =>
            tool.name !== AST_GREP_TOOL_NAME
                ? tool
                : {
                      ...tool,
                      execute: async (input, ctx) => {
                          const result = await tool.execute(input, ctx);
                          if (!result.isError) log.record(result.output);
                          return result;
                      },
                  },
        ),
    );
}

/** True when the finding cites an ast-grep rule AND an ast-grep call in this
 *  run returned a match for that rule in the finding's file. The model cannot
 *  claim proof it did not get from the tool. */
export function isProvenByAstGrep(
    finding: FinderSuggestion,
    astGrepOutputs: readonly string[],
): boolean {
    const ruleId = astGrepRuleIdOf(finding);
    const file = stripLeading(finding.relevantFile);
    if (!ruleId || !file) return false;
    return astGrepOutputs.some(
        (output) => output.includes(ruleId) && output.includes(file),
    );
}

/** Is `file` one of the linked guides (or inside a linked skill/directory)? */
export function isLinkedGuide(
    file: string,
    guideFiles: readonly string[],
): boolean {
    const f = stripLeading(file);
    return guideFiles.some((raw) => {
        const g = stripLeading(raw);
        if (!g) return false;
        if (f === g) return true;
        // A skill is linked by its SKILL.md; its reference files sit beside it.
        const dir = /(^|\/)SKILL\.md$/i.test(g)
            ? g.replace(/\/?SKILL\.md$/i, '')
            : g.replace(/\/+$/, '');
        return dir.length > 0 && f.startsWith(`${dir}/`);
    });
}

/**
 * The quote gate. Every candidate is a convention finding; each either passes
 * with its guide section or is rejected with `quote-not-found` and a detail
 * saying why. Never throws: a guide that cannot be read rejects the finding
 * (an unprovable quote is not published).
 *
 * `guideFiles`, when non-empty, restricts the quotable files to the guides
 * linked to this agent: a sentence from an arbitrary repository file is not a
 * team rule.
 */
export async function checkConventionQuotes(
    candidates: readonly FinderSuggestion[],
    readGuide: GuideFileReader,
    guideFiles: readonly string[] = [],
): Promise<ConventionCheckResult> {
    const passed: ConventionCheckPassed[] = [];
    const rejected: ConventionCheckRejected[] = [];
    const cache = new Map<string, Promise<string | null>>();
    const read = (file: string) => {
        if (!cache.has(file)) {
            cache.set(
                file,
                readGuide(file).catch(() => null),
            );
        }
        return cache.get(file)!;
    };
    const reject = (finding: FinderSuggestion, detail: string) =>
        rejected.push({ finding, reason: QUOTE_NOT_FOUND, detail });

    for (const finding of candidates) {
        const file = stripLeading(finding.source?.file ?? '');
        const quote = finding.source?.quote ?? '';
        if (!file || !quote.trim()) {
            reject(finding, 'convention finding without source file or quote');
            continue;
        }
        if (astGrepRuleIdOf(finding)) {
            reject(finding, 'cites an ast-grep rule this run never matched');
            continue;
        }
        if (normalizeQuoteText(quote).length < MIN_QUOTE_LENGTH) {
            reject(finding, 'quote too short to identify a rule');
            continue;
        }
        if (guideFiles.length > 0 && !isLinkedGuide(file, guideFiles)) {
            reject(finding, `${file} is not a guide linked to this review`);
            continue;
        }
        const content = await read(file);
        if (content == null) {
            reject(finding, `${file} not found on the target branch`);
            continue;
        }
        const sectionText = findQuoteSection(content, quote);
        if (sectionText == null) {
            reject(finding, `quote not found in ${file} on the target branch`);
            continue;
        }
        passed.push({ finding, sectionText });
    }
    return { passed, rejected };
}

/**
 * Reads guides from the PR's target branch in the review sandbox:
 * `git show refs/remotes/origin/<base>:<file>` (where the sandbox fetches the
 * base branch). Never the PR head — a PR that adds or edits a
 * guide must not get to quote its own rule.
 */
export function makeTargetBranchGuideReader(
    remoteCommands: RemoteCommands | undefined,
    baseBranch: string | undefined,
): GuideFileReader | undefined {
    const exec = remoteCommands?.exec;
    if (!exec || !baseBranch) return undefined;
    return async (file: string) => {
        const path = stripLeading(file);
        if (!path || path.split('/').includes('..')) return null;
        // Fully qualified: a bare `origin/<base>` resolves a tag of that name
        // first, and a fetch auto-follows tags onto the PR head.
        const r = await exec(
            `git show ${shellQuote(`refs/remotes/origin/${baseBranch}:${path}`)}`,
        );
        return r.exitCode === 0 ? r.stdout : null;
    };
}

function stripLeading(p: string): string {
    return (p ?? '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.?\/+/, '');
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
