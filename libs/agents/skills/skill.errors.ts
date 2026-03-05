export enum SkillErrorCode {
    SKILL_NOT_FOUND = 'SKILL_NOT_FOUND',
    MCP_REQUIRED_PRECHECK_FAILED = 'MCP_REQUIRED_PRECHECK_FAILED',
    MCP_CONNECTION_UNAVAILABLE = 'MCP_CONNECTION_UNAVAILABLE',
}

export abstract class SkillExecutionError extends Error {
    public readonly code: SkillErrorCode;
    public readonly skillName?: string;
    public readonly metadata?: Record<string, unknown>;

    protected constructor(params: {
        code: SkillErrorCode;
        message: string;
        skillName?: string;
        metadata?: Record<string, unknown>;
    }) {
        super(params.message);
        this.name = this.constructor.name;
        this.code = params.code;
        this.skillName = params.skillName;
        this.metadata = params.metadata;
    }
}

export class SkillNotFoundError extends Error {
    constructor(skillName: string) {
        super(
            `Skill '${skillName}' not found: no SKILL.md at libs/agents/skills/${skillName}/SKILL.md`,
        );
        this.name = 'SkillNotFoundError';
    }
}

export class McpConnectionUnavailableError extends SkillExecutionError {
    public readonly skillName: string;
    public readonly availableProviders: string[];
    public readonly causeMessage: string;

    constructor(params: {
        skillName: string;
        availableProviders?: string[];
        causeMessage?: string;
    }) {
        const availableProviders = params.availableProviders ?? [];
        const causeMessage = params.causeMessage ?? 'Unknown MCP error';

        super({
            code: SkillErrorCode.MCP_CONNECTION_UNAVAILABLE,
            skillName: params.skillName,
            message: `Skill '${params.skillName}' could not connect to required MCP servers. Available providers: ${
                availableProviders.length > 0
                    ? availableProviders.join(', ')
                    : 'none'
            }. Cause: ${causeMessage}`,
            metadata: {
                availableProviders,
                causeMessage,
            },
        });
        this.skillName = params.skillName;
        this.availableProviders = availableProviders;
        this.causeMessage = causeMessage;
    }
}

export function isMcpConnectivityError(error: unknown): boolean {
    const message =
        error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();

    return (
        message.includes('failed to connect to any mcp server') ||
        message.includes('no mcp servers configured') ||
        message.includes('mcp adapter not connected') ||
        message.includes('econnrefused') ||
        message.includes('fetch failed')
    );
}

export class RequiredMcpPreflightError extends SkillExecutionError {
    public readonly skillName: string;
    public readonly requiredMcps: Array<{
        category: string;
        label: string;
        examples?: string;
    }>;
    public readonly availableProviders: string[];

    constructor(
        skillName: string,
        requiredMcps: Array<{
            category: string;
            label: string;
            examples?: string;
        }>,
        availableProviders: string[] = [],
    ) {
        const normalizedRequiredMcps = requiredMcps.map((mcp) => ({
            category: mcp.category,
            label: mcp.label,
            ...(mcp.examples ? { examples: mcp.examples } : {}),
        }));
        const required = requiredMcps
            .map((mcp) => `${mcp.label} (${mcp.category})`)
            .join(', ');

        super({
            code: SkillErrorCode.MCP_REQUIRED_PRECHECK_FAILED,
            skillName,
            message: `Skill '${skillName}' requires external MCP integrations before execution. Missing required categories: ${required}. Available providers: ${
                availableProviders.length > 0
                    ? availableProviders.join(', ')
                    : 'none'
            }.`,
            metadata: {
                requiredMcps: normalizedRequiredMcps,
                availableProviders,
            },
        });
        this.skillName = skillName;
        this.requiredMcps = normalizedRequiredMcps;
        this.availableProviders = availableProviders;
    }
}
