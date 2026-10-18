import * as crypto from 'crypto';

import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import type {
    CodeSuggestion,
    CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import type { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { isAnalyzerSuggestion } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import type { DedupGroup } from '@libs/code-review/infrastructure/agents/engine/prefer-analyzer-keep';

/**
 * How a custom agent's findings reach the PR (#2172): its own severity floor,
 * comment limit, fix policy and format.
 * Every helper leaves findings without a `customAgent` stamp untouched.
 */

type Finding = Partial<CodeSuggestion>;
export type CustomAgentsById = ReadonlyMap<string, CustomAgentConfig>;

export function indexCustomAgents(
    agents: readonly CustomAgentConfig[] | undefined,
): Map<string, CustomAgentConfig> {
    return new Map((agents ?? []).map((agent) => [agent.id, agent]));
}

export function isCustomAgentFinding(s: Finding): boolean {
    return !!s.customAgent?.id;
}

const SEVERITY_RANK: Record<string, number> = {
    [SeverityLevel.CRITICAL]: 0,
    [SeverityLevel.HIGH]: 1,
    [SeverityLevel.MEDIUM]: 2,
    [SeverityLevel.LOW]: 3,
};

const rankOf = (severity?: string): number =>
    SEVERITY_RANK[(severity || '').toLowerCase()] ?? SEVERITY_RANK.medium;

/**
 * The agent's own severity floor, when it set one: true keeps the finding,
 * false drops it. Undefined when the team's global filter decides.
 */
export function customAgentSeverityVerdict(
    s: Finding,
    agents: CustomAgentsById,
): boolean | undefined {
    if (!isCustomAgentFinding(s)) {
        return undefined;
    }
    const minSeverity = agents.get(s.customAgent.id)?.presentation?.minSeverity;
    if (!minSeverity) {
        return undefined;
    }
    return rankOf(s.severity) <= rankOf(minSeverity);
}

export function hasCustomAgentSeverityFloor(agents: CustomAgentsById): boolean {
    return [...agents.values()].some((a) => !!a.presentation?.minSeverity);
}

/**
 * Keeps each agent's `maxComments` most severe findings. The rest are kept
 * as discarded by quantity, with a reason that keeps them out of the
 * fallback comments (create-file-comments posts quantity discards when a
 * line comment fails).
 */
export function capCustomAgentComments(
    suggestions: Finding[],
    agents: CustomAgentsById,
): { kept: Finding[]; overflow: Finding[] } {
    const keptByAgent = new Map<string, Set<Finding>>();
    for (const [id, agent] of agents) {
        const max = agent.presentation?.maxComments;
        if (!max) {
            continue;
        }
        const own = suggestions.filter((s) => s.customAgent?.id === id);
        if (own.length <= max) {
            continue;
        }
        const ranked = own
            .map((s, i) => ({ s, i }))
            .sort(
                (a, b) =>
                    rankOf(a.s.severity) - rankOf(b.s.severity) || a.i - b.i,
            )
            .slice(0, max)
            .map(({ s }) => s);
        keptByAgent.set(id, new Set(ranked));
    }

    const kept: Finding[] = [];
    const overflow: Finding[] = [];
    for (const s of suggestions) {
        const cap = s.customAgent?.id
            ? keptByAgent.get(s.customAgent.id)
            : undefined;
        if (!cap || cap.has(s)) {
            kept.push(s);
            continue;
        }
        overflow.push({
            ...s,
            priorityStatus: PriorityStatus.DISCARDED_BY_QUANTITY,
            deliveryStatus: DeliveryStatus.NOT_SENT,
            notSentReason: 'custom-agent-max-comments',
        });
    }
    return { kept, overflow };
}

/** `suggestedFix: 'never'` publishes the finding without its code. Returns how many it stripped. */
export function stripCustomAgentFixes(
    suggestions: Finding[],
    agents: CustomAgentsById,
): number {
    let stripped = 0;
    for (const s of suggestions) {
        if (!isCustomAgentFinding(s) || !s.improvedCode) {
            continue;
        }
        if (
            agents.get(s.customAgent.id)?.presentation?.suggestedFix === 'never'
        ) {
            s.improvedCode = '';
            stripped++;
        }
    }
    return stripped;
}

/** The agent's writing instructions, which replace the team's for its findings. */
export function customAgentWriting(
    s: Finding,
    agents: CustomAgentsById,
): string | undefined {
    if (!isCustomAgentFinding(s)) {
        return undefined;
    }
    const writing = agents.get(s.customAgent.id)?.presentation?.writing?.trim();
    return writing || undefined;
}

/**
 * A custom agent finding inside the agent's lane: it applies the team rule
 * the agent was asked for, and quotes it.
 */
export function isCustomAgentLaneFinding(s: Finding): boolean {
    return (
        isCustomAgentFinding(s) &&
        s.kind === 'convention' &&
        !!s.source?.quote?.trim()
    );
}

/**
 * Picks the survivor of a dedup group a custom agent shares with native
 * findings. The agent's finding keeps the group only inside its lane (see
 * isCustomAgentLaneFinding): the team asked that agent for that rule, so its
 * tag and wording are the ones the PR shows. A bug the agent reported outside
 * its instructions takes no credit: the generalist's finding stays, or gets
 * the group back. A scanner finding keeps the group (see preferAnalyzerKeep),
 * since it carries a proof the agent's does not.
 */
export function preferCustomAgentKeep(
    groups: DedupGroup[],
    suggestions: Finding[],
): DedupGroup[] {
    const at = (index: number): Finding | undefined =>
        Number.isInteger(index) && index >= 0 && index < suggestions.length
            ? suggestions[index]
            : undefined;

    return groups.map((group) => {
        const keep = at(group.keep);
        if (
            !keep ||
            isCustomAgentLaneFinding(keep) ||
            isAnalyzerSuggestion(keep)
        ) {
            return group;
        }
        const duplicates = group.duplicates ?? [];
        const firstDuplicate = (test: (s: Finding) => boolean) =>
            duplicates.find((index) => {
                const s = at(index);
                return !!s && test(s);
            });
        const promoted =
            firstDuplicate(isCustomAgentLaneFinding) ??
            (isCustomAgentFinding(keep)
                ? firstDuplicate((s) => !isCustomAgentFinding(s))
                : undefined);
        if (promoted === undefined) {
            return group;
        }
        return {
            keep: promoted,
            duplicates: [
                group.keep,
                ...duplicates.filter((index) => index !== promoted),
            ],
        };
    });
}

/**
 * Takes a custom agent's own findings back out of a dedup group when they sit
 * on code that does not overlap. The agent already merged what it saw as one
 * problem; two findings it kept apart on different code are two problems (a
 * duplicate-code agent reports each clone pair once), however alike their
 * wording reads to the dedup model. Findings on overlapping lines, and
 * findings of different agents or native ones, still merge. A taken-out index
 * is left unclassified, which the dedup keeps as unique.
 */
export function keepOwnFindingsApart(
    groups: DedupGroup[],
    suggestions: Finding[],
): DedupGroup[] {
    const at = (index: number): Finding | undefined =>
        Number.isInteger(index) && index >= 0 && index < suggestions.length
            ? suggestions[index]
            : undefined;
    const overlaps = (a: Finding, b: Finding): boolean => {
        if (a.relevantFile !== b.relevantFile) return false;
        const aStart = Number(a.relevantLinesStart) || 0;
        const bStart = Number(b.relevantLinesStart) || 0;
        const aEnd = Math.max(aStart, Number(a.relevantLinesEnd) || aStart);
        const bEnd = Math.max(bStart, Number(b.relevantLinesEnd) || bStart);
        return aStart <= bEnd && bStart <= aEnd;
    };

    return groups.flatMap((group) => {
        const keep = at(group.keep);
        if (!keep || !group.duplicates?.length) {
            return [group];
        }
        // The finding each agent's other findings in the group must overlap.
        // Under a custom agent's keep, only that agent's own findings are
        // checked, against the keep. Under a native keep (an off-lane agent
        // does not take the group), each agent keeps the finding on the
        // keep's code, or its first one, merged; the rest go apart.
        const anchors = new Map<string, Finding>();
        if (isCustomAgentFinding(keep)) {
            anchors.set(keep.customAgent.id, keep);
        } else {
            const own = group.duplicates
                .map(at)
                .filter((s): s is Finding => !!s && isCustomAgentFinding(s));
            for (const s of [...own.filter((f) => overlaps(f, keep)), ...own]) {
                if (!anchors.has(s.customAgent.id)) {
                    anchors.set(s.customAgent.id, s);
                }
            }
        }
        const duplicates = group.duplicates.filter((index) => {
            const s = at(index);
            if (!s || !isCustomAgentFinding(s)) return true;
            const anchor = anchors.get(s.customAgent.id);
            return !anchor || anchor === s || overlaps(s, anchor);
        });
        if (duplicates.length === group.duplicates.length) return [group];
        // Emptied by this split: nothing left to merge into the keep.
        return duplicates.length ? [{ ...group, duplicates }] : [];
    });
}

/**
 * Agents with `format: 'single-comment'` publish their findings as one
 * PR-level comment instead of inline. Returns the inline rest and one
 * PR-level entry per such agent.
 */
export function collectSingleComments(
    suggestions: Finding[],
    agents: CustomAgentsById,
): { inline: Finding[]; prLevel: ISuggestionByPR[]; grouped: Finding[] } {
    const byAgent = new Map<string, Finding[]>();
    const inline: Finding[] = [];
    for (const s of suggestions) {
        const agent = s.customAgent?.id
            ? agents.get(s.customAgent.id)
            : undefined;
        if (agent?.presentation?.format !== 'single-comment') {
            inline.push(s);
            continue;
        }
        if (!byAgent.has(agent.id)) {
            byAgent.set(agent.id, []);
        }
        byAgent.get(agent.id)!.push(s);
    }

    const prLevel = [...byAgent.entries()].map(([id, findings]) =>
        buildSingleComment(agents.get(id)!, findings),
    );
    return { inline, prLevel, grouped: [...byAgent.values()].flat() };
}

function buildSingleComment(
    agent: CustomAgentConfig,
    findings: Finding[],
): ISuggestionByPR {
    const ordered = [...findings].sort(
        (a, b) => rankOf(a.severity) - rankOf(b.severity),
    );
    // An agent with its own writing instructions may write in any language,
    // and its findings already come in that voice (the formatter rewrites
    // their title and body). The comment then adds no English words of its
    // own: no "finding" heading and no severity names, which the order (most
    // severe first) and the comment's severity badge already carry.
    const ownVoice = !!agent.presentation?.writing?.trim();
    const items = ordered.map((s, i) => {
        const location = s.relevantFile
            ? s.relevantLinesStart
                ? `\`${s.relevantFile}:${s.relevantLinesStart}\``
                : `\`${s.relevantFile}\``
            : '';
        const severity =
            s.severity && !ownVoice ? ` (${s.severity.toLowerCase()})` : '';
        const title =
            s.oneSentenceSummary?.trim() || (ownVoice ? '' : 'Finding');
        const head = title
            ? `**${title}**${location ? ` — ${location}` : ''}`
            : location;
        const body = (s.suggestionContent || '').trim();
        return `${i + 1}. ${head}${severity}${body ? `\n\n   ${body.replace(/\n/g, '\n   ')}` : ''}`;
    });
    const count = findings.length;
    const summary = ownVoice
        ? `${agent.name} (${count})`
        : `${agent.name}: ${count} finding${count === 1 ? '' : 's'} in this pull request`;
    const content = items.join('\n\n');

    return {
        id: crypto.randomUUID(),
        suggestionContent: content,
        fullExplanation: content,
        oneSentenceSummary: summary,
        label: LabelType.CUSTOM_AGENT,
        severity: (ordered[0]?.severity?.toLowerCase() ||
            SeverityLevel.MEDIUM) as SeverityLevel,
        deliveryStatus: DeliveryStatus.NOT_SENT,
        customAgent: {
            id: agent.id,
            name: agent.name,
            color: agent.presentation?.tag?.color,
        },
    };
}
