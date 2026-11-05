import type {
    KodyRuleMutationResult,
    CreateKodyRuleRequest,
    KodyRule,
    KodyRuleScope,
    KodyRuleSeverity,
    KodyRuleStatus,
    KodyRulesStatusResult,
    UpdateKodyRuleRequest,
    UserKodyRulePayload,
    ViewKodyRulesRequest,
} from '../types/rules.js';
import { CommandError } from '../utils/command-errors.js';
import { api } from './api/index.js';
import { userContextService } from './user-context.service.js';

export type UpdateKodyRuleInput = {
    ruleId: string;
} & UpdateKodyRuleRequest;

export type RulesTeamOption = {
    /** Team name or id; only read for a logged-in user (a team key is bound to its team). */
    team?: string;
};

const VALID_SEVERITIES: KodyRuleSeverity[] = [
    'low',
    'medium',
    'high',
    'critical',
];

// Input spellings → the value the API stores. `'pull request'` is what the
// CLI documented before; the review pipeline only matches `'pull-request'`.
const SCOPE_ALIASES: Record<string, KodyRuleScope> = {
    'pull-request': 'pull-request',
    'pull request': 'pull-request',
    'pull_request': 'pull-request',
    'file': 'file',
};

const RULES_FEATURE = 'Kody Rules';

type StoredKodyRule = KodyRule & {
    origin?: string;
    examples?: Array<{ snippet?: string; isCorrect?: boolean }>;
    inheritance?: {
        inheritable?: boolean;
        include?: string[];
        exclude?: string[];
    };
    sourcePath?: string;
    sourceAnchor?: string;
};

/**
 * The stored rule as the save DTO takes it: only the fields it declares (it
 * rejects unknown ones), nested objects trimmed to theirs.
 */
export function storedRulePayload(
    stored: StoredKodyRule,
): Omit<UserKodyRulePayload, 'teamId'> {
    const defined = <T extends object>(value: T): T =>
        Object.fromEntries(
            Object.entries(value).filter(([, entry]) => entry !== undefined),
        ) as T;
    return defined({
        type: stored.type || 'standard',
        title: stored.title,
        rule: stored.rule,
        severity: stored.severity ?? 'medium',
        scope: stored.scope,
        path: stored.path,
        repositoryId: stored.repositoryId,
        directoryId: stored.directoryId,
        origin: stored.origin,
        status: stored.status,
        sourcePath: stored.sourcePath,
        sourceAnchor: stored.sourceAnchor,
        examples: (stored.examples ?? []).map((example) => ({
            snippet: example.snippet,
            isCorrect: example.isCorrect,
        })),
        ...(stored.inheritance
            ? {
                  inheritance: defined({
                      inheritable: stored.inheritance.inheritable,
                      include: stored.inheritance.include,
                      exclude: stored.inheritance.exclude,
                  }),
              }
            : {}),
    });
}

class RulesService {
    async createRule(
        input: CreateKodyRuleRequest,
        options: RulesTeamOption = {},
    ): Promise<KodyRuleMutationResult> {
        const payload: CreateKodyRuleRequest = {
            title: this.requireText(input.title, 'title'),
            rule: this.requireText(input.rule, 'rule'),
            repositoryId:
                this.normalizeOptionalText(input.repositoryId) || 'global',
            severity: this.normalizeSeverity(input.severity ?? 'medium'),
            scope: this.normalizeScope(input.scope ?? 'file'),
            path: this.normalizeOptionalText(input.path) || '**/*',
        };

        const credential = await userContextService.resolveCredential();
        if (credential.kind === 'team-key') {
            return api.rules.createRule(credential.accessToken, payload);
        }

        const ctx = await userContextService.resolve(RULES_FEATURE, options);
        // Same defaults the team-key route applies server-side
        // (cli-kody-rules.controller.ts convertToDTO), so a rule looks the same
        // whichever credential created it.
        return api.rules.saveRuleAsUser(ctx.accessToken, {
            title: payload.title,
            rule: payload.rule,
            type: 'standard',
            severity: payload.severity as KodyRuleSeverity,
            scope: payload.scope,
            path: payload.path,
            repositoryId: payload.repositoryId,
            origin: 'cli',
            status: 'active',
            examples: [],
            teamId: ctx.teamId,
        });
    }

    async updateRule(
        input: UpdateKodyRuleInput,
        options: RulesTeamOption = {},
    ): Promise<KodyRuleMutationResult> {
        const ruleId = this.requireText(input.ruleId, 'rule-id');
        const payload = this.buildUpdatePayload(input);

        const credential = await userContextService.resolveCredential();
        if (credential.kind === 'team-key') {
            return api.rules.updateRule(
                credential.accessToken,
                ruleId,
                payload,
            );
        }

        const ctx = await userContextService.resolve(RULES_FEATURE, options);
        const existing = await this.findOneAsUser(ctx.accessToken, ruleId);

        // Send the whole stored rule with the user's changes on top, as the
        // web form does. A partial payload is not safe: the API validates it
        // into a CreateKodyRuleDto whose undeclared fields are own `undefined`
        // properties, and spreading that over the stored rule wipes status,
        // scope, path, examples and the rest (kodyRules.service.ts merge).
        return api.rules.saveRuleAsUser(ctx.accessToken, {
            ...storedRulePayload(existing),
            uuid: ruleId,
            ...(payload.title ? { title: payload.title } : {}),
            ...(payload.rule ? { rule: payload.rule } : {}),
            ...(payload.severity ? { severity: payload.severity } : {}),
            ...(payload.scope ? { scope: payload.scope } : {}),
            ...(payload.path ? { path: payload.path } : {}),
            ...(payload.repositoryId
                ? { repositoryId: payload.repositoryId }
                : {}),
            teamId: ctx.teamId,
        });
    }

    async viewRules(
        input: ViewKodyRulesRequest = {},
        options: RulesTeamOption = {},
    ): Promise<KodyRule[]> {
        const query: ViewKodyRulesRequest = {
            repositoryId: this.normalizeOptionalText(input.repositoryId),
            ruleId: this.normalizeOptionalText(input.ruleId),
        };

        const credential = await userContextService.resolveCredential();
        if (credential.kind === 'team-key') {
            return api.rules.viewRules(credential.accessToken, query);
        }

        const ctx = await userContextService.resolve(RULES_FEATURE, options);
        return api.rules.findRulesAsUser(ctx.accessToken, query);
    }

    /**
     * Delete, pause or resume. Goes through the same status endpoint the web
     * settings page uses, so under centralized config the change is proposed
     * as a pull request instead of written directly
     * (change-status-kody-rules.use-case.ts).
     */
    async changeStatus(
        ruleIds: string[],
        status: KodyRuleStatus,
        options: RulesTeamOption = {},
    ): Promise<KodyRulesStatusResult> {
        const ids = [
            ...new Set(
                ruleIds
                    .map((id) => this.normalizeOptionalText(id))
                    .filter((id): id is string => !!id),
            ),
        ];
        if (ids.length === 0) {
            throw new CommandError(
                'INVALID_INPUT',
                'Provide at least one --uuid.',
            );
        }

        const ctx = await userContextService.resolve(
            `Deleting, pausing or resuming ${RULES_FEATURE}`,
            options,
        );

        return api.rules.changeStatusAsUser(ctx.accessToken, {
            ruleIds: ids,
            status,
            teamId: ctx.teamId,
        });
    }

    private async findOneAsUser(
        accessToken: string,
        ruleId: string,
    ): Promise<KodyRule> {
        const [existing] = await api.rules.findRulesAsUser(accessToken, {
            ruleId,
        });
        if (!existing) {
            throw new CommandError(
                'INVALID_INPUT',
                `Kody Rule '${ruleId}' not found.`,
            );
        }
        return existing;
    }

    private buildUpdatePayload(
        input: UpdateKodyRuleInput,
    ): UpdateKodyRuleRequest {
        const payload: UpdateKodyRuleRequest = {};

        const title = this.normalizeOptionalText(input.title);
        if (title) {
            payload.title = title;
        }

        const rule = this.normalizeOptionalText(input.rule);
        if (rule) {
            payload.rule = rule;
        }

        if (input.severity !== undefined) {
            payload.severity = this.normalizeSeverity(input.severity);
        }

        if (input.scope !== undefined) {
            payload.scope = this.normalizeScope(input.scope);
        }

        const path = this.normalizeOptionalText(input.path);
        if (path) {
            payload.path = path;
        }

        const repositoryId = this.normalizeOptionalText(input.repositoryId);
        if (repositoryId) {
            payload.repositoryId = repositoryId;
        }

        if (Object.keys(payload).length === 0) {
            throw new CommandError(
                'INVALID_INPUT',
                'Provide at least one field to update: --repo-id, --title, --rule, --severity, --scope, or --path.',
            );
        }

        return payload;
    }

    private normalizeSeverity(value: string): KodyRuleSeverity {
        const normalized = value.trim().toLowerCase() as KodyRuleSeverity;
        if (!VALID_SEVERITIES.includes(normalized)) {
            throw new CommandError(
                'INVALID_INPUT',
                `Invalid severity '${value}'. Use one of: ${VALID_SEVERITIES.join(', ')}.`,
            );
        }

        return normalized;
    }

    private normalizeScope(value: string): KodyRuleScope {
        const normalized = SCOPE_ALIASES[value.trim().toLowerCase()];
        if (!normalized) {
            throw new CommandError(
                'INVALID_INPUT',
                `Invalid scope '${value}'. Use one of: pull-request, file.`,
            );
        }

        return normalized;
    }

    private requireText(value: string, field: string): string {
        const normalized = value.trim();
        if (!normalized) {
            throw new CommandError(
                'INVALID_INPUT',
                `--${field} cannot be empty.`,
            );
        }

        return normalized;
    }

    private normalizeOptionalText(value?: string): string | undefined {
        const normalized = value?.trim();
        return normalized ? normalized : undefined;
    }
}

export { RulesService };
export const rulesService = new RulesService();
