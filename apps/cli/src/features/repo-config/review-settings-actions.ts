import chalk from 'chalk';
import {
    reviewSettingsService,
    type ModelListResult,
    type SettingsMutationResult,
    type SettingsScope,
    type SettingsShowResult,
} from '../../services/review-settings.service.js';
import { exitWithCode, isCliExitError } from '../../utils/cli-exit.js';
import {
    CommandError,
    normalizeCommandError,
} from '../../utils/command-errors.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import {
    REVIEW_SETTINGS,
    type ReviewSettingSection,
} from '../../utils/review-settings-catalog.js';
import type {
    ApprovalPolicy,
    FormattedConfigLevel,
    TestByokModelResult,
} from '../../types/review-settings.js';

export type ReviewSettingsTargetOptions = {
    team?: string;
    directory?: string;
    json?: boolean;
};

export type ReviewSettingsShowOptions = ReviewSettingsTargetOptions & {
    fileOverlay?: boolean;
};

export type ReviewSettingsSetOptions = ReviewSettingsTargetOptions & {
    createDirectory?: boolean;
};

export type ReviewModelSetOptions = ReviewSettingsTargetOptions & {
    force?: boolean;
};

export type RiskPreviewOptions = ReviewSettingsTargetOptions & {
    pr: string;
    criteria?: string;
};

export type ApprovalPreviewOptions = {
    team?: string;
    json?: boolean;
    pr: string;
    policies?: string;
    assumeClean?: boolean;
    assumeEnabled?: boolean;
};

const LEVEL_LABEL: Record<FormattedConfigLevel, string> = {
    default: 'default',
    global: 'global',
    repository: 'repository',
    repository_file: 'kodus-config.yml (repository)',
    directory: 'directory',
    directory_file: 'kodus-config.yml (directory)',
};

function fail(error: unknown): void {
    // An exit raised inside the try (e.g. `model test` failing) is already
    // reported; normalizing it again prints "CLI exited with code 1".
    if (isCliExitError(error)) {
        throw error;
    }
    const normalized = normalizeCommandError(error);
    cliError(chalk.red(normalized.message));
    exitWithCode(normalized.exitCode);
}

export function describeScope(scope: SettingsScope): string {
    if (scope.level === 'global') {
        return 'global settings';
    }
    if (scope.level === 'repository') {
        return `${scope.repositoryName}`;
    }
    return `${scope.repositoryName}:${scope.directoryPath}`;
}

function formatValue(value: unknown): string {
    if (value === undefined) {
        return chalk.gray('(not set)');
    }
    if (typeof value === 'string') {
        const oneLine = value.replace(/\s+/g, ' ').trim();
        if (oneLine === '') {
            return chalk.gray('""');
        }
        return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
    }
    // The default ignorePaths alone holds over a thousand patterns.
    if (Array.isArray(value) && value.length > 5) {
        const head = JSON.stringify(value.slice(0, 5)).slice(0, -1);
        return `${head}, ...] ${chalk.gray(`(${value.length} items, --json for all)`)}`;
    }
    const serialized = JSON.stringify(value);
    return serialized.length > 200
        ? `${serialized.slice(0, 197)}... ${chalk.gray('(--json for all)')}`
        : serialized;
}

function formatOrigin(
    level: FormattedConfigLevel,
    scope: SettingsScope,
): string {
    if (level === scope.level) {
        return chalk.cyan('set here');
    }
    return chalk.gray(`from ${LEVEL_LABEL[level]}`);
}

export function formatSettingsShow(result: SettingsShowResult): string[] {
    const lines = [
        chalk.bold(
            `Code review settings for ${describeScope(result.scope)} (team ${result.team})`,
        ),
        `Review model: ${result.model.value || chalk.gray('BYOK main model')} ${formatOrigin(result.model.level, result.scope)}`,
    ];
    if (result.kodusConfigFile) {
        lines.push(`kodus-config.yml: ${result.kodusConfigFile}`);
    }

    let section: ReviewSettingSection | undefined;
    for (const setting of result.settings) {
        if (setting.section !== section) {
            section = setting.section;
            lines.push('', chalk.bold(`[${section}]`));
        }
        lines.push(
            `  ${setting.key} = ${formatValue(setting.value)}  ${formatOrigin(setting.level, result.scope)}`,
        );
    }
    return lines;
}

function printMutation(
    result: SettingsMutationResult & { changed?: boolean },
    verb: string,
): void {
    if (result.changed === false) {
        cliInfo(
            chalk.yellow(
                `${result.key} is not set at ${describeScope(result.scope)}; it already inherits.`,
            ),
        );
        return;
    }

    if (result.centralized) {
        cliInfo(
            chalk.green(
                `${result.key} change proposed for ${describeScope(result.scope)}`,
            ),
        );
        cliInfo(
            result.centralized.message ||
                'Centralized config is enabled. Change queued in a pull request.',
        );
        if (result.centralized.prUrl) {
            cliInfo(`Pull request: ${result.centralized.prUrl}`);
        }
        return;
    }

    cliInfo(
        chalk.green(
            `${result.key} ${verb} ${formatValue(result.value)} at ${describeScope(result.scope)}`,
        ),
    );
    if (result.overriddenByFile) {
        cliInfo(
            chalk.yellow(
                `Reviews keep using the value from ${LEVEL_LABEL[result.overriddenByFile]}, which overrides this scope.`,
            ),
        );
    }
}

export async function reviewSettingsShowAction(
    repository: string,
    options: ReviewSettingsShowOptions = {},
): Promise<void> {
    try {
        const result = await reviewSettingsService.show(
            {
                repository,
                directory: options.directory,
                team: options.team,
            },
            { includeFileOverlay: options.fileOverlay !== false },
        );

        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        for (const line of formatSettingsShow(result)) {
            cliInfo(line);
        }
    } catch (error) {
        fail(error);
    }
}

export async function riskPreviewAction(
    repository: string,
    options: RiskPreviewOptions,
): Promise<void> {
    try {
        const result = await reviewSettingsService.previewRisk(
            { repository, directory: options.directory, team: options.team },
            /^\d+$/.test(options.pr) ? Number(options.pr) : NaN,
            options.criteria,
        );
        const { assessment, files } = result;
        if (options.json) {
            cliInfo(
                JSON.stringify(
                    {
                        status: assessment.status,
                        ...(assessment.status === 'assessed' && {
                            riskIdentified: assessment.riskIdentified,
                        }),
                        changedFiles: files.length,
                    },
                    null,
                    2,
                ),
            );
            return;
        }

        if (assessment.status === 'assessed') {
            cliInfo(assessment.riskIdentified ? 'Risk found' : 'No risk found');
        } else {
            cliInfo(
                assessment.status === 'unavailable'
                    ? 'Assessment unavailable'
                    : 'Assessment disabled',
            );
        }
        if ('reason' in assessment) {
            cliInfo(assessment.reason);
        }
        cliInfo(`Changed files: ${files.length}`);
    } catch (error) {
        fail(error);
    }
}

function approvalPolicyOutput(policy: ApprovalPolicy) {
    return {
        id: policy.id,
        name: policy.name,
        enabled: policy.enabled,
        labels: policy.labels,
        authors: policy.authors,
        authorTeams: policy.authorTeams,
        includedFiles: policy.includedFiles,
        excludedFiles: policy.excludedFiles,
        maxChangedLines: policy.maxChangedLines,
        lineCountExcludedFiles: policy.lineCountExcludedFiles,
        hasEligibilityInstruction: !!policy.instruction?.trim(),
    };
}

export async function listApprovalsAction(
    repository: string,
    options: ReviewSettingsTargetOptions,
    policyId?: string,
): Promise<void> {
    try {
        const result = await reviewSettingsService.listApprovalPolicies({
            repository,
            ...options,
        });
        if (policyId) {
            const policy = result.policies.find(({ id }) => id === policyId);
            if (!policy) {
                throw new CommandError(
                    'INVALID_INPUT',
                    `Approval policy '${policyId}' was not found at this scope.`,
                );
            }
            cliInfo(JSON.stringify(approvalPolicyOutput(policy), null, 2));
        } else if (options.json) {
            cliInfo(
                JSON.stringify(
                    {
                        scope: result.scope,
                        level: result.level,
                        policies: result.policies.map(approvalPolicyOutput),
                    },
                    null,
                    2,
                ),
            );
        } else {
            cliInfo(
                `Approval policies for ${describeScope(result.scope)} ${formatOrigin(result.level, result.scope)}`,
            );
            for (const { id, name, enabled } of result.policies) {
                cliInfo(
                    `  ${id} · ${name} · ${enabled ? 'enabled' : 'disabled'}`,
                );
            }
            if (!result.policies.length) {
                cliInfo('  No approval policies configured.');
            }
        }
    } catch (error) {
        fail(error);
    }
}

export async function toggleApprovalAction(
    repository: string,
    policyId: string,
    enabled: boolean,
    options: ReviewSettingsTargetOptions,
): Promise<void> {
    try {
        const result = await reviewSettingsService.setApprovalPolicyEnabled(
            { repository, ...options },
            policyId,
            enabled,
        );
        const { scope, policy, changed, centralized } = result;
        if (options.json) {
            cliInfo(
                JSON.stringify(
                    {
                        scope,
                        policy: approvalPolicyOutput(policy),
                        changed,
                        prUrl: centralized?.prUrl,
                    },
                    null,
                    2,
                ),
            );
            return;
        }
        const state = enabled ? 'enabled' : 'disabled';
        cliInfo(
            `${policyId} ${changed === false ? `already ${state}` : state} at ${describeScope(scope)}.`,
        );
        if (result.centralized?.prUrl) {
            cliInfo(`Pull request: ${result.centralized.prUrl}`);
        }
    } catch (error) {
        fail(error);
    }
}

export async function previewApprovalAction(
    repository: string,
    options: ApprovalPreviewOptions,
): Promise<void> {
    try {
        const result = await reviewSettingsService.previewApproval(
            { repository, team: options.team },
            {
                prNumber: /^\d+$/.test(options.pr) ? Number(options.pr) : NaN,
                rawPolicies: options.policies,
                assumeClean: options.assumeClean,
                assumeEnabled: options.assumeEnabled,
            },
        );
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        const { assumptions, decision } = result;
        cliInfo(
            `Approval preview: ${decision.kind === 'approve' ? 'would approve' : decision.kind}. ${decision.reason}`,
        );
        if (assumptions.cleanReview) {
            cliInfo('  Assumption: review is clean.');
        }
        if (assumptions.automaticApproval) {
            cliInfo('  Assumption: automatic approval is enabled.');
        }
        if (assumptions.draftPolicies) {
            cliInfo('  Using policies supplied for this preview.');
        }
        for (const policy of decision.policies ?? []) {
            cliInfo(
                `  ${policy.policyName}: ${policy.status} (${policy.reason})`,
            );
        }
    } catch (error) {
        fail(error);
    }
}

export async function reviewSettingsSetAction(
    repository: string,
    key: string,
    value: string,
    options: ReviewSettingsSetOptions = {},
): Promise<void> {
    try {
        const result = await reviewSettingsService.set(
            {
                repository,
                directory: options.directory,
                team: options.team,
                createDirectory: options.createDirectory,
            },
            key,
            value,
        );

        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printMutation(result, 'set to');
    } catch (error) {
        fail(error);
    }
}

export async function reviewSettingsUnsetAction(
    repository: string,
    key: string,
    options: ReviewSettingsTargetOptions = {},
): Promise<void> {
    try {
        const result = await reviewSettingsService.unset(
            {
                repository,
                directory: options.directory,
                team: options.team,
            },
            key,
        );

        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printMutation(result, 'now inherits');
    } catch (error) {
        fail(error);
    }
}

export async function reviewSettingsKeysAction(
    options: { json?: boolean } = {},
): Promise<void> {
    if (options.json) {
        cliInfo(JSON.stringify(REVIEW_SETTINGS, null, 2));
        return;
    }

    let section: ReviewSettingSection | undefined;
    for (const setting of REVIEW_SETTINGS) {
        if (setting.section !== section) {
            section = setting.section;
            cliInfo('');
            cliInfo(chalk.bold(`[${section}]`));
        }
        const type = setting.values ? setting.values.join(' | ') : setting.type;
        cliInfo(`  ${setting.key} (${type}): ${setting.description}`);
    }
}

function printModelList(result: ModelListResult): void {
    if (!result.byokConfigured) {
        cliInfo(
            chalk.yellow(
                'No BYOK provider is configured for this organization; reviews use the Kodus-managed model.',
            ),
        );
        return;
    }

    cliInfo(`Provider: ${result.provider}`);
    cliInfo(`Main model: ${result.mainModel ?? chalk.gray('(none)')}`);
    if (result.models.length === 0) {
        cliInfo(chalk.gray('No additional models are configured.'));
        return;
    }
    cliInfo('Models:');
    for (const model of result.models) {
        const name = model.name !== model.modelId ? ` (${model.name})` : '';
        const status = model.resolvable ? '' : chalk.yellow(' [unresolvable]');
        cliInfo(`- ${model.modelId}${name}${status}`);
    }
}

export async function reviewModelListAction(
    options: { json?: boolean } = {},
): Promise<void> {
    try {
        const result = await reviewSettingsService.listModels();
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printModelList(result);
    } catch (error) {
        fail(error);
    }
}

export async function reviewModelSetAction(
    repository: string,
    modelId: string,
    options: ReviewModelSetOptions = {},
): Promise<void> {
    try {
        const result = await reviewSettingsService.setModel(
            {
                repository,
                directory: options.directory,
                team: options.team,
                force: options.force,
            },
            modelId,
        );
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        if (result.value === '') {
            printMutation({ ...result, key: 'Review model' }, 'now inherits');
            return;
        }
        printMutation({ ...result, key: 'Review model' }, 'set to');
    } catch (error) {
        fail(error);
    }
}

function printModelTest(modelId: string, result: TestByokModelResult): void {
    if (result.ok) {
        const how =
            result.verifiedBy === 'catalog'
                ? ' (listed by the provider for your key; not called)'
                : '';
        cliInfo(
            chalk.green(`${modelId} works (${result.latencyMs} ms)${how}.`),
        );
        return;
    }
    cliInfo(
        chalk.red(
            `${modelId} failed: ${result.providerMessage || result.message || result.code}`,
        ),
    );
}

export async function reviewModelTestAction(
    modelId: string,
    options: { json?: boolean } = {},
): Promise<void> {
    try {
        const result = await reviewSettingsService.testModel(modelId);
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
        } else {
            printModelTest(modelId, result);
        }
        if (!result.ok) {
            exitWithCode(1);
        }
    } catch (error) {
        fail(error);
    }
}
