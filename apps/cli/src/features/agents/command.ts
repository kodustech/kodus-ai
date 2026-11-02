import chalk from 'chalk';
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import {
    agentStatusLine,
    CUSTOM_AGENT_TEMPLATES,
    customAgentsService,
    tryResultHeadline,
    type AgentInput,
    type AgentSummary,
    type LevelTarget,
    type SaveResult,
} from '../../services/custom-agents.service.js';
import type {
    CustomAgent,
    CustomAgentTryTrace,
} from '../../types/custom-agents.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import {
    CommandError,
    normalizeCommandError,
} from '../../utils/command-errors.js';
import { cliError, cliInfo } from '../../utils/logger.js';

type LevelOptions = {
    team?: string;
    repo?: string;
    directory?: string;
    json?: boolean;
};

type AgentFieldOptions = {
    name?: string;
    instructions?: string;
    fromFile?: string;
    include?: string[];
    exclude?: string[];
    color?: string;
    // Not --format: that is the CLI's global output-format option, which
    // would swallow it.
    commentFormat?: string;
    minSeverity?: string;
    maxComments?: string;
    suggestedFix?: string;
    writing?: string;
    model?: string;
    astGrep?: string;
    astGrepFile?: string;
    skill?: string[];
    doc?: string[];
    unlink?: string[];
    enable?: boolean;
};

const collect = (value: string, previous: string[] = []) => [
    ...previous,
    value,
];

function levelTarget(options: LevelOptions): LevelTarget {
    return {
        team: options.team,
        repo: options.repo,
        directory: options.directory,
    };
}

function levelLabel(
    result: Pick<SaveResult, 'level' | 'repository' | 'directory'>,
): string {
    if (result.level === 'global') {
        return 'global';
    }
    if (result.level === 'directory') {
        return `${result.repository?.name} · ${result.directory?.label}`;
    }
    return result.repository?.name ?? 'repository';
}

/** `.json` holds agent fields; any other file is the instructions. */
export async function readAgentFile(
    file: string,
): Promise<Pick<AgentInput, 'fromJson' | 'instructions'>> {
    let content: string;
    try {
        content = await fs.readFile(file, 'utf-8');
    } catch {
        throw new CommandError('INVALID_INPUT', `Cannot read file '${file}'.`);
    }
    if (path.extname(file).toLowerCase() !== '.json') {
        return { instructions: content };
    }
    try {
        const parsed = JSON.parse(content) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not an object');
        }
        return { fromJson: parsed as Partial<CustomAgent> };
    } catch {
        throw new CommandError(
            'INVALID_INPUT',
            `'${file}' is not a JSON object with agent fields.`,
        );
    }
}

export async function toAgentInput(
    options: AgentFieldOptions,
): Promise<AgentInput> {
    const fromFile = options.fromFile
        ? await readAgentFile(options.fromFile)
        : {};
    let astGrep = options.astGrep;
    if (options.astGrepFile) {
        try {
            astGrep = await fs.readFile(options.astGrepFile, 'utf-8');
        } catch {
            throw new CommandError(
                'INVALID_INPUT',
                `Cannot read file '${options.astGrepFile}'.`,
            );
        }
    }
    return {
        fromJson: fromFile.fromJson,
        instructions: options.instructions ?? fromFile.instructions,
        name: options.name,
        include: options.include,
        exclude: options.exclude,
        color: options.color,
        format: options.commentFormat,
        minSeverity: options.minSeverity,
        maxComments: options.maxComments,
        suggestedFix: options.suggestedFix,
        writing: options.writing,
        model: options.model,
        astGrep,
        enabled: options.enable ? true : undefined,
        linkSkills: options.skill,
        linkDocs: options.doc,
        unlink: options.unlink,
    };
}

function withLevelOptions(command: Command): Command {
    return command
        .option(
            '--team <name|id>',
            'Team (required when your organization has more than one)',
        )
        .option(
            '--repo <repository>',
            "Repository id or name, or 'global' for the agents every repository gets",
            'global',
        )
        .option(
            '--directory <path|id>',
            'Directory of --repo with its own settings',
        )
        .option('--json', 'Output as JSON');
}

function withAgentFieldOptions(command: Command): Command {
    return command
        .option('--name <name>', 'Agent name (also its @kody -v command)')
        .option('--instructions <text>', 'What the agent reviews and how')
        .option(
            '--from-file <file>',
            'Read agent fields from a .json file, or the instructions from any other file (e.g. .md)',
        )
        .option(
            '--include <glob>',
            'Run only on changed files matching this glob (repeatable)',
            collect,
        )
        .option(
            '--exclude <glob>',
            'Skip changed files matching this glob (repeatable)',
            collect,
        )
        .option('--color <hex>', 'Tag color of its comments')
        .option(
            '--comment-format <format>',
            'Comment format: inline or single-comment',
        )
        .option(
            '--min-severity <severity>',
            'Lowest severity it posts: low, medium, high, critical, or none',
        )
        .option('--max-comments <n>', 'Most comments it posts per review')
        .option(
            '--suggested-fix <mode>',
            'Suggested fixes: when-confident or never',
        )
        .option('--writing <text>', 'How its comments are written')
        .option(
            '--model <modelId>',
            "BYOK model id it runs on ('' to use the routing table)",
        )
        .option(
            '--ast-grep <yaml|path>',
            'ast-grep rule YAML, or the repository path of a rule file',
        )
        .option(
            '--ast-grep-file <file>',
            'Read the ast-grep rule YAML from a local file',
        )
        .option(
            '--skill <path>',
            'Link a skill folder of the repository (repeatable)',
            collect,
        )
        .option(
            '--doc <path>',
            'Link a doc file of the repository (repeatable)',
            collect,
        )
        .option(
            '--unlink <path>',
            'Unlink a skill or doc (repeatable)',
            collect,
        );
}

function printAgent(
    agent: AgentSummary,
    windowDays: number | undefined,
    perRepository: boolean,
): void {
    cliInfo(
        `${chalk.bold(agent.name)} ${chalk.dim(`(${agent.id})`)}${agent.origin === 'inherited' ? chalk.dim(' · from the repository') : ''}`,
    );
    cliInfo(
        `  ${agentStatusLine(agent, agent.status, windowDays, perRepository)}`,
    );
    cliInfo(
        `  Enabled: ${agent.enabled ? 'yes' : 'no'} · @kody -v ${agent.name}`,
    );
    if (agent.skills.length) {
        cliInfo(`  Skills: ${agent.skills.join(', ')}`);
    }
    if (agent.docs.length) {
        cliInfo(`  Docs: ${agent.docs.join(', ')}`);
    }
    const tools = [
        ...(agent.tools.mcp ?? []).map((entry) => `MCP ${entry.integrationId}`),
        ...(agent.tools.cli ?? []).map((cli) => `${cli.name} CLI`),
        agent.tools.astGrepConfig?.trim() ? 'ast-grep' : '',
    ].filter(Boolean);
    if (tools.length) {
        cliInfo(`  Tools: ${tools.join(', ')}`);
    }
    if (agent.models?.run) {
        cliInfo(`  Model: ${agent.models.run}`);
    }
}

function printSaveResult(result: SaveResult, done: string): void {
    if (result.centralized) {
        cliInfo(
            chalk.green('Change proposed through centralized pull request.'),
        );
        if (result.centralized.message) {
            cliInfo(result.centralized.message);
        }
        if (result.centralized.prUrl) {
            cliInfo(`PR URL: ${result.centralized.prUrl}`);
        }
        return;
    }
    cliInfo(chalk.green(`${done} (${levelLabel(result)}).`));
    if (result.note) {
        cliInfo(chalk.yellow(result.note));
    }
}

function printTrace(trace: CustomAgentTryTrace): void {
    cliInfo(chalk.bold(tryResultHeadline(trace)));
    for (const warning of trace.warnings ?? []) {
        cliInfo(
            chalk.yellow(
                `  ! ${warning.kind}${warning.detail ? `: ${warning.detail}` : ''}`,
            ),
        );
    }
    if (trace.skillsOpened.length) {
        cliInfo(
            `Skills opened: ${trace.skillsOpened.map((skill) => skill.path).join(', ')}`,
        );
    }
    if (trace.toolCalls.length) {
        cliInfo(`Tool calls: ${trace.toolCalls.length}`);
    }
    for (const finding of trace.findings) {
        const where = `${finding.file}${finding.lineStart ? `:${finding.lineStart}` : ''}`;
        const mark =
            finding.verdict === 'kept'
                ? finding.wouldPost
                    ? chalk.green('would post')
                    : chalk.cyan('kept')
                : chalk.dim(finding.verdict);
        cliInfo(
            `- [${mark}] ${where} ${finding.severity ? `(${finding.severity}) ` : ''}${finding.summary}`,
        );
        if (finding.reason && finding.verdict !== 'kept') {
            cliInfo(chalk.dim(`    ${finding.reason}`));
        }
    }
}

async function run(action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export function createAgentsCommand(): Command {
    const agents = new Command('agents')
        .description(
            'List, create, edit, turn on/off, delete and try custom review agents (requires kodus auth login)',
        )
        .showHelpAfterError();

    withLevelOptions(
        agents
            .command('list')
            .description('List the custom agents a review runs at this level'),
    ).action((options: LevelOptions) =>
        run(async () => {
            const result = await customAgentsService.list(levelTarget(options));
            if (options.json) {
                cliInfo(JSON.stringify(result, null, 2));
                return;
            }
            if (result.agents.length === 0) {
                cliInfo(
                    chalk.yellow(`No custom agents (${levelLabel(result)}).`),
                );
                return;
            }
            cliInfo(chalk.dim(`Team ${result.team} · ${levelLabel(result)}`));
            result.agents.forEach((agent) =>
                printAgent(agent, result.windowDays, !!result.repository),
            );
        }),
    );

    withLevelOptions(
        agents
            .command('show <agent>')
            .description(
                'Show one agent (id, name or @kody -v command) with its full configuration',
            ),
    ).action((agentRef: string, options: LevelOptions) =>
        run(async () => {
            const agent = await customAgentsService.show(
                agentRef,
                levelTarget(options),
            );
            if (options.json) {
                cliInfo(JSON.stringify(agent, null, 2));
                return;
            }
            printAgent(agent, agent.windowDays, agent.level !== 'global');
            cliInfo('');
            cliInfo(chalk.bold('Instructions'));
            cliInfo(agent.instructions || chalk.dim('(none)'));
            cliInfo('');
            cliInfo(
                `Comments: ${agent.presentation.format} · suggested fix ${agent.presentation.suggestedFix}${agent.presentation.minSeverity ? ` · min severity ${agent.presentation.minSeverity}` : ''}${agent.presentation.maxComments ? ` · max ${agent.presentation.maxComments}` : ''} · color ${agent.presentation.tag.color}`,
            );
        }),
    );

    withAgentFieldOptions(
        withLevelOptions(
            agents
                .command('create')
                .description(
                    'Create an agent. It starts turned off: try it, then run `kodus agents enable`',
                )
                .option(
                    '--template <id>',
                    `Start from a template: ${CUSTOM_AGENT_TEMPLATES.map((template) => template.id).join(', ')}`,
                    'blank',
                )
                .option('--enable', 'Turn the agent on right away'),
        ),
    ).action(
        (options: LevelOptions & AgentFieldOptions & { template?: string }) =>
            run(async () => {
                const input = await toAgentInput(options);
                const result = await customAgentsService.create(
                    { ...input, template: options.template },
                    levelTarget(options),
                );
                if (options.json) {
                    cliInfo(JSON.stringify(result, null, 2));
                    return;
                }
                printSaveResult(
                    result,
                    `Agent ${result.agent?.name} created${result.agent?.enabled ? '' : ', turned off'}`,
                );
            }),
    );

    withAgentFieldOptions(
        withLevelOptions(
            agents
                .command('update <agent>')
                .description('Change an agent; only the fields passed change'),
        ),
    ).action((agentRef: string, options: LevelOptions & AgentFieldOptions) =>
        run(async () => {
            const input = await toAgentInput({ ...options, enable: undefined });
            const result = await customAgentsService.update(
                agentRef,
                input,
                levelTarget(options),
            );
            if (options.json) {
                cliInfo(JSON.stringify(result, null, 2));
                return;
            }
            printSaveResult(result, `Agent ${result.agent?.name} updated`);
        }),
    );

    for (const [name, enabled] of [
        ['enable', true],
        ['disable', false],
    ] as const) {
        withLevelOptions(
            agents
                .command(`${name} <agent>`)
                .description(
                    enabled
                        ? 'Turn an agent on: reviews run it'
                        : "Turn an agent off: reviews don't run it",
                ),
        ).action((agentRef: string, options: LevelOptions) =>
            run(async () => {
                const result = await customAgentsService.setEnabled(
                    agentRef,
                    enabled,
                    levelTarget(options),
                );
                if (options.json) {
                    cliInfo(JSON.stringify(result, null, 2));
                    return;
                }
                printSaveResult(
                    result,
                    `${result.agent?.name} turned ${enabled ? 'on' : 'off'}`,
                );
            }),
        );
    }

    withLevelOptions(
        agents
            .command('delete <agent>')
            .description(
                'Delete an agent. Its findings stay on past pull requests',
            ),
    ).action((agentRef: string, options: LevelOptions) =>
        run(async () => {
            const result = await customAgentsService.delete(
                agentRef,
                levelTarget(options),
            );
            if (options.json) {
                cliInfo(JSON.stringify(result, null, 2));
                return;
            }
            printSaveResult(result, `Agent ${result.deletedAgentId} deleted`);
        }),
    );

    withAgentFieldOptions(
        withLevelOptions(
            agents
                .command('try <agent>')
                .description(
                    'Run an agent on one pull request without posting; agent fields passed here change only this run',
                )
                .requiredOption('--pr <url>', 'Pull request link of --repo'),
        ),
    ).action(
        (
            agentRef: string,
            options: LevelOptions & AgentFieldOptions & { pr: string },
        ) =>
            run(async () => {
                const input = await toAgentInput(options);
                const hasDraft = Object.entries(input).some(
                    ([, value]) => value !== undefined,
                );
                if (!options.json) {
                    cliInfo(
                        chalk.dim(
                            'Running the agent on the pull request; this can take a few minutes...',
                        ),
                    );
                }
                const result = await customAgentsService.tryAgent(
                    agentRef,
                    options.pr,
                    levelTarget(options),
                    { input: hasDraft ? input : undefined },
                );
                if (options.json) {
                    cliInfo(JSON.stringify(result, null, 2));
                    return;
                }
                printTrace(result.trace);
            }),
    );

    return agents;
}

export const agentsCommand = createAgentsCommand();
