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

    private async fromHistory(
        filePath: string,
    ): Promise<IIssueOwner | undefined> {
        this.historyReady ??= this.deepen();
        if (!(await this.historyReady)) {
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
        const header = this.history.authHeader
            ? '-c http.extraHeader="$GIT_AUTH_HEADER" '
            : '';
        const result = await this.sandbox
            .run(
                `git -C ${this.sandbox.repoDir} ${header}fetch --quiet --filter=blob:none --deepen=${HISTORY_DEPTH} ${shellQuote(this.history.cloneUrl)} ${shellQuote(`refs/heads/${this.history.branch}`)}`,
                {
                    timeoutMs: 180_000,
                    ...(this.history.authHeader
                        ? { envs: { GIT_AUTH_HEADER: this.history.authHeader } }
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
