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
 * comment limit, fix policy and format, and shadow mode, where nothing posts.
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
 * Shadow findings leave the stream before dedup: one that absorbed a native
 * finding and then never posted would take the native comment with it. An
 * agent whose config is gone counts as shadow, the default mode.
 */
export function splitShadowFindings(
    suggestions: Finding[],
    agents: CustomAgentsById,
): { active: Finding[]; shadow: Finding[] } {
    const active: Finding[] = [];
    const shadow: Finding[] = [];
    for (const s of suggestions) {
        if (!isCustomAgentFinding(s)) {
            active.push(s);
            continue;
        }
        const agent = agents.get(s.customAgent.id);
        if (agent?.presentation?.mode === 'post') {
            active.push(s);
            continue;
        }
        shadow.push({
            ...s,
            priorityStatus: PriorityStatus.PRIORITIZED,
            deliveryStatus: DeliveryStatus.NOT_SENT,
            notSentReason: 'custom-agent-shadow',
        });
    }
    return { active, shadow };
}

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
 * Makes the custom agent's finding the survivor of a dedup group it shares
 * with native findings: the team asked that agent for that problem, so its
 * tag and wording are the ones the PR shows. A scanner finding keeps the
 * group (see preferAnalyzerKeep), since it carries a proof the agent's does not.
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
        if (!keep || isCustomAgentFinding(keep) || isAnalyzerSuggestion(keep)) {
            return group;
        }
        const duplicates = group.duplicates ?? [];
        const promoted = duplicates.find((index) => {
            const s = at(index);
            return !!s && isCustomAgentFinding(s);
        });
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
    const items = ordered.map((s, i) => {
        const where = s.relevantFile
            ? s.relevantLinesStart
                ? ` — \`${s.relevantFile}:${s.relevantLinesStart}\``
                : ` — \`${s.relevantFile}\``
            : '';
        const severity = s.severity ? ` (${s.severity.toLowerCase()})` : '';
        const title = s.oneSentenceSummary?.trim() || 'Finding';
        const body = (s.suggestionContent || '').trim();
        return `${i + 1}. **${title}**${where}${severity}${body ? `\n\n   ${body.replace(/\n/g, '\n   ')}` : ''}`;
    });
    const count = findings.length;
    const summary = `${agent.name}: ${count} finding${count === 1 ? '' : 's'} in this pull request`;
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
