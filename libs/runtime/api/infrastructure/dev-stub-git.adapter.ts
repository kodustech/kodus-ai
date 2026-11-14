import { appendFileSync, readFileSync } from 'fs';

import type { DefaultBranchHead, OrgTeam, RuntimeGitPort, RuntimeRepoTokenIssuer } from '../domain/ports';

// Dev and e2e only: the product's Git calls for Kody Runtime answered from a
// JSON file instead of the Git platform, so a local stack can run setups,
// /mcp/env sessions and recipe PRs end to end against a tarball stub and a
// local cell, without a real GitHub installation. Selected by
// RUNTIME_DEV_GIT_STUB_FILE and refused under NODE_ENV=production.
//
// File: { "repos": { "<repositoryId>": { "branch": "main", "sha": "<40 hex>", "files": { "<path>": "<text>" } } } }
// Pull requests it "opens" are appended to <file>.prs.jsonl.

export const DEV_STUB_DOWNLOAD_TOKEN = 'stub-download-token';

type StubRepo = { branch: string; sha: string; files?: Record<string, string> };

export function devGitStubFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const file = env.RUNTIME_DEV_GIT_STUB_FILE?.trim();
    if (!file) return undefined;
    if (env.NODE_ENV === 'production') throw new Error('RUNTIME_DEV_GIT_STUB_FILE is a dev-only switch and is refused in production');
    return file;
}

export class DevStubRuntimeGit implements RuntimeGitPort {
    private prs = 0;

    constructor(
        private readonly file: string,
        /** Everything the stub does not answer goes to the real adapter. */
        private readonly real: RuntimeGitPort,
    ) {}

    private repo(repositoryId: string): StubRepo | undefined {
        const doc = JSON.parse(readFileSync(this.file, 'utf8')) as { repos?: Record<string, StubRepo> };
        return doc.repos?.[repositoryId];
    }

    async getDefaultBranchHead(input: OrgTeam & { repositoryId: string; repositoryName: string }): Promise<DefaultBranchHead> {
        const r = this.repo(input.repositoryId);
        return r ? { status: 'ok', branch: r.branch, sha: r.sha } : this.real.getDefaultBranchHead(input);
    }

    async readFileAtCommit(input: OrgTeam & { repositoryId: string; repositoryName: string; path: string; sha: string; maxBytes: number }) {
        const r = this.repo(input.repositoryId);
        if (!r) return this.real.readFileAtCommit(input);
        if (input.sha !== r.sha) return null;
        const text = r.files?.[input.path];
        if (text !== undefined && Buffer.byteLength(text) > input.maxBytes) throw new Error(`${input.path} is larger than ${input.maxBytes} bytes`);
        return text ?? null;
    }

    async listFilesAtCommit(input: OrgTeam & { repositoryId: string; repositoryName: string; sha: string }): Promise<string[] | 'unsupported_platform'> {
        const r = this.repo(input.repositoryId);
        if (!r) return this.real.listFilesAtCommit ? this.real.listFilesAtCommit(input) : 'unsupported_platform';
        return input.sha === r.sha ? Object.keys(r.files ?? {}) : [];
    }

    async openPullRequestWithFiles(input: Parameters<NonNullable<RuntimeGitPort['openPullRequestWithFiles']>>[0]) {
        if (!this.repo(input.repositoryId)) return this.real.openPullRequestWithFiles ? this.real.openPullRequestWithFiles(input) : null;
        this.prs += 1;
        const number = 9000 + this.prs;
        appendFileSync(`${this.file}.prs.jsonl`, `${JSON.stringify({ number, ...input })}\n`);
        return { number, url: `http://dev-git-stub.invalid/${input.repositoryName}/pull/${number}` };
    }

    getPullRequestHead(input: Parameters<RuntimeGitPort['getPullRequestHead']>[0]) {
        return this.real.getPullRequestHead(input);
    }
    getPullRequestDiff(input: Parameters<RuntimeGitPort['getPullRequestDiff']>[0]) {
        return this.real.getPullRequestDiff(input);
    }
    resolveGitIdentity(input: Parameters<RuntimeGitPort['resolveGitIdentity']>[0]) {
        return this.real.resolveGitIdentity(input);
    }
    userCanWrite(input: Parameters<RuntimeGitPort['userCanWrite']>[0]) {
        return this.real.userCanWrite(input);
    }
    isOrganizationMember(input: Parameters<RuntimeGitPort['isOrganizationMember']>[0]) {
        return this.real.isOrganizationMember(input);
    }
}

/** The stub tarball server accepts this token; a repo outside the stub file gets a real one. */
export class DevStubRepoTokenIssuer implements RuntimeRepoTokenIssuer {
    constructor(
        private readonly file: string,
        private readonly real: RuntimeRepoTokenIssuer,
    ) {}

    async issue(input: OrgTeam & { repositoryId: string; repositoryName: string }) {
        const doc = JSON.parse(readFileSync(this.file, 'utf8')) as { repos?: Record<string, unknown> };
        return doc.repos?.[input.repositoryId] ? DEV_STUB_DOWNLOAD_TOKEN : this.real.issue(input);
    }
}
