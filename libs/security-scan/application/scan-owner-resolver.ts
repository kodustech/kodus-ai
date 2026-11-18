import type { IIssueOwner } from '@libs/issues/domain/interfaces/issues.interface';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import {
    CODEOWNERS_LOCATIONS,
    CodeownersRule,
    ownersFor,
    parseCodeowners,
} from '../domain/codeowners';

/** How the resolver reaches history that the shallow sandbox clone lacks. */
export interface HistoryAccess {
    cloneUrl: string;
    branch: string;
    /** `Authorization: …` header for a private repository; never put on the command line. */
    authHeader?: string;
}

const HISTORY_DEPTH = 1000;

/**
 * The owner of a security finding when no pull request names one: the
 * CODEOWNERS entry for the file, else the last person who changed it.
 * Neither is mapped to a provider user yet: the name (and email, when there
 * is one) is what the issue shows.
 */
export class ScanOwnerResolver {
    private rules: CodeownersRule[] | undefined;
    private historyReady: Promise<boolean> | undefined;
    private readonly cache = new Map<string, IIssueOwner | undefined>();

    constructor(
        private readonly sandbox: SandboxInstance,
        private readonly history?: HistoryAccess,
    ) {}

    async ownerOf(filePath: string): Promise<IIssueOwner | undefined> {
        if (this.cache.has(filePath)) {
            return this.cache.get(filePath);
        }
        const owner =
            (await this.fromCodeowners(filePath)) ??
            (await this.fromHistory(filePath));
        this.cache.set(filePath, owner);
        return owner;
    }

    private async fromCodeowners(
        filePath: string,
    ): Promise<IIssueOwner | undefined> {
        if (!this.rules) {
            this.rules = [];
            for (const location of CODEOWNERS_LOCATIONS) {
                const content = await this.sandbox.remoteCommands
                    .read(location, 0, 0)
                    .catch(() => '');
                if (content.trim()) {
                    this.rules = parseCodeowners(content);
                    break;
                }
            }
        }
        const [first] = ownersFor(this.rules, filePath);
        if (!first) {
            return undefined;
        }
        const isEmail = !first.startsWith('@') && first.includes('@');
        return {
            gitId: '',
            username: isEmail ? first.split('@')[0] : first,
            ...(isEmail ? { email: first } : {}),
            origin: 'codeowners',
        };
    }

    /**
     * Fetch the history the last-author fallback reads. Call it right after
     * the clone, before any repository code runs in the sandbox: it is the
     * only command that carries the provider token, and code that ran first
     * (an install script, a reproduction test) could have planted a git hook
     * or config that reads it. Without this call there is no last author.
     */
    async prepareHistory(): Promise<void> {
        this.historyReady ??= this.deepen();
        await this.historyReady;
    }

    private async fromHistory(
        filePath: string,
    ): Promise<IIssueOwner | undefined> {
        if (!this.historyReady || !(await this.historyReady)) {
            return undefined;
        }
        const result = await this.sandbox
            .run(
                `git -C ${this.sandbox.repoDir} log -1 --format=%an%x09%ae -- ${shellQuote(filePath)}`,
                { timeoutMs: 30_000 },
            )
            .catch(() => undefined);
        const [name, email] = (result?.stdout ?? '').trim().split('\t');
        if (!name) {
            return undefined;
        }
        return {
            gitId: '',
            username: name,
            ...(email ? { email } : {}),
            origin: 'last_author',
        };
    }

    /**
     * The sandbox clone holds one commit. Fetch the history without file
     * contents (a blobless deepen), which is what `git log -- <file>` needs.
     */
    private async deepen(): Promise<boolean> {
        if (!this.history) {
            return false;
        }
        // Git reads the credential from its environment, never from argv.
        // Disable hooks, filesystem monitors and recursive submodule fetches
        // before any repository code can run.
        const result = await this.sandbox
            .run(
                `git -C ${this.sandbox.repoDir} -c core.hooksPath=/dev/null -c core.fsmonitor= fetch --no-recurse-submodules --quiet --filter=blob:none --deepen=${HISTORY_DEPTH} ${shellQuote(this.history.cloneUrl)} ${shellQuote(`refs/heads/${this.history.branch}`)}`,
                {
                    timeoutMs: 180_000,
                    ...(this.history.authHeader
                        ? {
                              envs: {
                                  GIT_CONFIG_COUNT: '1',
                                  GIT_CONFIG_KEY_0: 'http.extraHeader',
                                  GIT_CONFIG_VALUE_0: this.history.authHeader,
                              },
                          }
                        : {}),
                },
            )
            .catch(() => undefined);
        return result?.exitCode === 0;
    }
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
