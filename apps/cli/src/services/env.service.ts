import type {
    EnvBlockerGroup,
    EnvFixResult,
    EnvHealth,
    EnvRecipeCheck,
    EnvRecipeGuide,
    EnvRecipeInput,
    EnvRecipeSubmit,
    EnvStatus,
    EnvTarget,
} from '../types/env.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CommandError } from '../utils/command-errors.js';
import { extractOrgRepoFromRemote } from '../utils/git-remote.js';
import { resolveTeamKeyAccess } from '../utils/team-key-auth.js';
import { request } from './api/api-core.js';

const ENV_AUTH_MESSAGE =
    'Kody Runtime environment commands require team-key auth with env:exec or env:fix. Run: kodus auth team-key --key <your-key>.\nGet your key from: https://app.kodus.io/organization/cli-keys';

const execFileAsync = promisify(execFile);

/** The `origin` remote of the working directory's repository, or null when there is none. */
async function originOfCwd(): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['remote', 'get-url', 'origin'],
            { cwd: process.cwd(), timeout: 5_000 },
        );
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

type Requester = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

type EnvChoice = { environmentId: string; repositoryName: string };

type ToolResult = {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
};

type JsonRpcResponse = {
    result?: ToolResult;
    error?: { code: number; message: string };
};

/**
 * `kodus env` talks to the same /mcp/env tools the dev's agent uses, so the
 * key's capability and repository checks are the same in both.
 */
export class EnvService {
    constructor(
        private readonly requester: Requester = request,
        private readonly remoteUrl: () => Promise<string | null> = originOfCwd,
    ) {}

    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        const { teamKey } = await resolveTeamKeyAccess(ENV_AUTH_MESSAGE);
        const response = await this.requester<JsonRpcResponse>('/mcp/env', {
            method: 'POST',
            headers: {
                'X-Team-Key': teamKey,
                'Accept': 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name, arguments: args },
            }),
        });
        if (response?.error) {
            throw new CommandError(
                'API_REQUEST_FAILED',
                response.error.message || 'The Kodus API refused the call.',
            );
        }
        const result = response?.result;
        const data =
            result?.structuredContent ??
            parseText(result?.content?.[0]?.text) ??
            {};
        if (result?.isError) {
            throw toolError(data);
        }
        return data as T;
    }

    /**
     * Runs a call that names an environment. A key that reaches several environments refuses a call that names none:
     * then the environment whose repository is this directory's git remote (`origin`, owner/name, case-insensitive)
     * is the one, and the call is made again with it. None or several match: the refusal stands, listing them.
     */
    private async targeted<T>(
        target: EnvTarget,
        call: (target: EnvTarget) => Promise<T>,
    ): Promise<T> {
        try {
            return await call(target);
        } catch (error) {
            const choices =
                error instanceof CommandError &&
                !target.environmentId &&
                !target.repositoryId &&
                error.details?.code === 'environment_required'
                    ? (error.details.environments as EnvChoice[])
                    : undefined;
            const picked = choices && (await this.environmentOfRemote(choices));
            if (!picked) {
                throw error;
            }
            return call({ ...target, environmentId: picked });
        }
    }

    private async environmentOfRemote(
        choices: EnvChoice[],
    ): Promise<string | undefined> {
        const parsed = extractOrgRepoFromRemote(await this.remoteUrl());
        if (!parsed) {
            return undefined;
        }
        const full = `${parsed.org}/${parsed.repo}`.toLowerCase();
        const matching = choices.filter((c) => {
            const name = c.repositoryName.toLowerCase();
            return name === full || name === parsed.repo.toLowerCase();
        });
        return matching.length === 1 ? matching[0].environmentId : undefined;
    }

    status(target: EnvTarget): Promise<EnvStatus> {
        return this.targeted(target, (t) =>
            this.callTool<EnvStatus>('env_blockers', compact(t)),
        );
    }

    /** The blocker to fix: the one named, or the only one. */
    pickBlocker(status: EnvStatus, signature?: string): EnvBlockerGroup {
        if (signature) {
            const found = status.blockers.find(
                (b) => b.signature === signature,
            );
            if (!found) {
                throw new CommandError(
                    'INVALID_INPUT',
                    `No blocker "${signature}" on this environment. Run: kodus env status`,
                );
            }
            return found;
        }
        if (status.blockers.length === 1) {
            return status.blockers[0];
        }
        throw new CommandError(
            'INVALID_INPUT',
            status.blockers.length
                ? 'This environment has more than one blocker; name it: kodus env fix <signature>. Run: kodus env status'
                : 'This environment has no blocker to fix.',
        );
    }

    fix(
        target: EnvTarget & { signature: string; fixId: string },
    ): Promise<EnvFixResult> {
        return this.targeted(target, (t) =>
            this.callTool<EnvFixResult>('env_fix', compact(t)),
        );
    }

    /** env_status: the state and which setup it reads (setupKey). */
    health(target: EnvTarget): Promise<EnvHealth> {
        return this.targeted(target, (t) =>
            this.callTool<EnvHealth>('env_status', compact(t)),
        );
    }

    /** env_recipe_guide: the rules a recipe is written by; static text, names no environment. */
    recipeGuide(): Promise<EnvRecipeGuide> {
        return this.callTool<EnvRecipeGuide>('env_recipe_guide', {});
    }

    /** env_recipe_check: what Kodus would refuse in the recipe; keeps nothing. */
    checkRecipe(input: EnvRecipeInput): Promise<EnvRecipeCheck> {
        return this.targeted(input, (t) =>
            this.callTool<EnvRecipeCheck>(
                'env_recipe_check',
                recipeArgs({ ...input, ...t }),
            ),
        );
    }

    /** env_recipe_submit: Kodus keeps the recipe and sets the environment up from it. */
    submitRecipe(input: EnvRecipeInput): Promise<EnvRecipeSubmit> {
        return this.targeted(input, (t) =>
            this.callTool<EnvRecipeSubmit>(
                'env_recipe_submit',
                recipeArgs({ ...input, ...t }),
            ),
        );
    }
}

const recipeArgs = (input: EnvRecipeInput) => ({
    ...compact({
        environmentId: input.environmentId,
        repositoryId: input.repositoryId,
    }),
    recipe: input.recipe,
    ...(input.files?.length ? { files: input.files } : {}),
});

const compact = (o: Record<string, unknown>) =>
    Object.fromEntries(
        Object.entries(o).filter(([, v]) => v !== undefined && v !== ''),
    );

function parseText(text?: string): Record<string, unknown> | undefined {
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return { message: text };
    }
}

function toolError(data: Record<string, unknown>): CommandError {
    const status = Number(data.status);
    const message =
        typeof data.message === 'string' ? data.message : 'The tool failed.';
    if (status === 401) {
        return new CommandError('AUTH_REQUIRED', ENV_AUTH_MESSAGE);
    }
    if (status === 400) {
        return new CommandError(
            'INVALID_INPUT',
            message,
            1,
            data.code === 'environment_required' &&
            Array.isArray(data.environments)
                ? { code: data.code, environments: data.environments }
                : undefined,
        );
    }
    if (status === 403) {
        return new CommandError(
            'AUTH_REQUIRED',
            `${message}. Turn the capability on for this key in Organization → CLI keys.`,
        );
    }
    if (status === 404) {
        return new CommandError(
            'INVALID_INPUT',
            `${message}. The key reaches only the repositories listed on it.`,
        );
    }
    return new CommandError('API_REQUEST_FAILED', message, 1, {
        status,
        code: data.code,
    });
}

export const envService = new EnvService();
