import * as yaml from 'js-yaml';

import { isIdeRuleSource } from '@libs/common/utils/kody-rules/file-patterns';
import {
    CUSTOM_AGENT_LIMITS,
    type KnowledgeItem,
    type KnowledgeLinkTarget,
    utf8ByteLength,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

import type { KnowledgeItemResolution } from './contracts';

export type AstGrepRuleReport = {
    ruleCount: number;
    ruleIds: string[];
    errors: string[];
    /** Set when `astGrepConfig` names a rule file of the repository. */
    rulesPath?: string;
};

/**
 * Counts the rules in an ast-grep rule YAML (one rule per document,
 * documents split by `---`). A document without `id` or `rule` is reported,
 * not counted.
 */
export function countAstGrepRules(
    source: string | undefined,
): AstGrepRuleReport {
    const report: AstGrepRuleReport = { ruleCount: 0, ruleIds: [], errors: [] };
    if (!source?.trim()) return report;

    // The tool refuses rules this large, so none of them would run.
    const bytes = utf8ByteLength(source);
    if (bytes > CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes) {
        report.errors.push(
            `The rules are ${bytes} bytes; ast-grep runs at most ${CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes}.`,
        );
        return report;
    }

    let documents: unknown[];
    try {
        documents = yaml.loadAll(source);
    } catch (error) {
        report.errors.push(
            `Not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        );
        return report;
    }

    documents.forEach((document, index) => {
        if (document === null || document === undefined) return;
        const rule = document as { id?: unknown; rule?: unknown };
        if (typeof rule !== 'object' || typeof rule.id !== 'string') {
            report.errors.push(`Rule ${index + 1} has no id.`);
            return;
        }
        if (!rule.rule || typeof rule.rule !== 'object') {
            report.errors.push(`Rule "${rule.id}" has no rule pattern.`);
            return;
        }
        report.ruleCount += 1;
        report.ruleIds.push(rule.id);
    });

    return report;
}

/** Stable key for a link target: `main-review` or `agent:<id>`. */
export const knowledgeTargetKey = (target: KnowledgeLinkTarget): string =>
    typeof target === 'string' ? target : `agent:${target.agentId}`;

export type KnowledgeTargetBudget = {
    target: string;
    skills: number;
    docs: number;
    docTokens: number;
    /** Each limit the target goes over. */
    over: Array<'skills' | 'docs' | 'docTokens'>;
};

/**
 * What each target (the main review, or one agent) loads, against the
 * per-target limits. Doc tokens count only the docs the reader could size.
 */
export function knowledgeBudgets(
    items: KnowledgeItem[],
    resolutions: KnowledgeItemResolution[],
): KnowledgeTargetBudget[] {
    const tokensByPath = new Map(
        resolutions.map((resolution) => [resolution.path, resolution.tokens]),
    );
    const budgets = new Map<string, KnowledgeTargetBudget>();

    for (const item of items) {
        for (const target of item.linkedTo ?? []) {
            const key = knowledgeTargetKey(target);
            const budget = budgets.get(key) ?? {
                target: key,
                skills: 0,
                docs: 0,
                docTokens: 0,
                over: [],
            };
            if (item.kind === 'skill') {
                budget.skills += 1;
            } else {
                budget.docs += 1;
                budget.docTokens += tokensByPath.get(item.path) ?? 0;
            }
            budgets.set(key, budget);
        }
    }

    return [...budgets.values()].map((budget) => ({
        ...budget,
        over: [
            ...(budget.skills > CUSTOM_AGENT_LIMITS.maxSkills
                ? (['skills'] as const)
                : []),
            ...(budget.docs > CUSTOM_AGENT_LIMITS.maxDocs
                ? (['docs'] as const)
                : []),
            ...(budget.docTokens > CUSTOM_AGENT_LIMITS.maxDocTokens
                ? (['docTokens'] as const)
                : []),
        ],
    }));
}

/**
 * A file that is also a Kody Rules source (AGENTS.md, .cursor/rules, …) is
 * already turned into rules by the IDE sync; linking it as well makes the
 * same guidance count twice.
 */
export const isKodyRuleSource = (path: string): boolean =>
    isIdeRuleSource(path);
