import { randomUUID } from 'node:crypto';
import { ExternalFindingsService } from '../../application/external-findings.service';
import { RuntimeRunRequestBuilder } from '../../application/run-request-builder.service';
import {
    ExternalAdmissionError,
    EXTERNAL_FINDINGS_QUOTA,
    type ExternalFindingsStore,
    type ExternalSubmissionAdmission,
    type ExternalSubmissionRecord,
} from '../../domain/external-findings';
import type { EnvKeyPrincipal } from '../../domain/env-tools';
import type {
    ProductEnvironmentStore,
    RuntimeEnvironmentReader,
    RuntimeGitPort,
} from '../../domain/ports';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
const NOW = new Date('2026-10-29T12:00:00.000Z');
const SHA = 'a'.repeat(40),
    BASE_SHA = 'b'.repeat(40);
const fixtureConfig = () => ({
    runTokenSecret: 'x'.repeat(48),
    secretSealKey: '7'.repeat(64),
    evidenceTtlSeconds: 300,
    pool: { defaultSize: 0, maxSize: 0 },
    machineSize: { maxPreset: 'large' as const },
    llmBudget: { perRun: 1000, perPullRequest: 2000, perOrgPerDay: 10000 },
    oncallUserIds: [],
    egressDenylist: [],
    streamLongPollMs: 200,
    streamPollIntervalMs: 20,
});

export class InMemoryExternalFindingsStore implements ExternalFindingsStore {
    records: ExternalSubmissionRecord[] = [];
    aliases = new Map<
        string,
        { receiptId: string; bodyHash: string; createdAt: string }
    >();
    requests: ExternalSubmissionAdmission['request'][] = [];
    readonly key = (org: string, key: string, message: string) =>
        JSON.stringify([org, key, message]);
    async quotaAvailable(
        org: string,
        key: string,
        repo: string,
        pr: number,
        at: string,
        amount: number,
    ) {
        const since = new Date(at);
        since.setUTCHours(0, 0, 0, 0);
        const messages = [...this.aliases.entries()].filter(([k, v]) => {
            const [o, ky] = JSON.parse(k);
            return (
                o === org && ky === key && v.createdAt >= since.toISOString()
            );
        }).length;
        const rows = this.records.filter(
            (r) =>
                r.organizationId === org && r.createdAt >= since.toISOString(),
        );
        return (
            rows
                .filter((r) => r.keyId === key)
                .reduce((n, r) => n + r.findingIds.length, 0) +
                amount <=
                1000 &&
            rows
                .filter((r) => r.repositoryId === repo && r.prNumber === pr)
                .reduce((n, r) => n + r.findingIds.length, 0) +
                amount <=
                1000 &&
            messages < 4000
        );
    }
    async byMessage(org: string, key: string, message: string) {
        const alias = this.aliases.get(this.key(org, key, message));
        const record =
            alias &&
            this.records.find(
                (r) =>
                    r.organizationId === org &&
                    r.keyId === key &&
                    r.receiptId === alias.receiptId,
            );
        return record && alias ? { record, bodyHash: alias.bodyHash } : null;
    }
    async byFingerprint(org: string, key: string, fingerprint: string) {
        return (
            this.records.find(
                (r) =>
                    r.organizationId === org &&
                    r.keyId === key &&
                    r.fingerprint === fingerprint,
            ) ?? null
        );
    }
    async byTask(org: string, id: string) {
        return (
            this.records.find(
                (r) =>
                    r.organizationId === org &&
                    (r.receiptId === id || r.verificationTaskId === id),
            ) ?? null
        );
    }
    async byFinding(org: string, id: string) {
        return (
            this.records
                .filter(
                    (r) =>
                        r.organizationId === org && r.findingIds.includes(id),
                )
                .sort((a, b) => b.attempt - a.attempt)[0] ?? null
        );
    }
    async complete(
        org: string,
        taskId: string,
        terminal: NonNullable<ExternalSubmissionRecord['terminal']>,
    ) {
        const record = this.records.find(
            (r) => r.organizationId === org && r.verificationTaskId === taskId,
        );
        if (!record) throw new ExternalAdmissionError('receipt_expired');
        record.terminal ??= structuredClone(terminal);
        return record;
    }
    async listExpiredTaskIds(org: string, at: string, limit: number) {
        if (limit < 1 || limit > 100) throw new RangeError('Invalid limit');
        return this.records
            .filter(
                (r) =>
                    r.organizationId === org &&
                    !r.refusal &&
                    !r.terminal &&
                    r.expiresAt <= at,
            )
            .sort(
                (a, b) =>
                    a.expiresAt.localeCompare(b.expiresAt) ||
                    a.receiptId.localeCompare(b.receiptId),
            )
            .slice(0, limit)
            .map((r) => r.verificationTaskId);
    }
    async purgeTerminal(org: string, cutoff: string, limit: number) {
        const terminalAt = (r: ExternalSubmissionRecord) =>
            r.terminal?.updatedAt ?? (r.refusal ? r.createdAt : undefined);
        const recentAlias = (r: ExternalSubmissionRecord) =>
            [...this.aliases.values()].some(
                (a) => a.receiptId === r.receiptId && a.createdAt >= cutoff,
            );
        const rows = this.records
            .filter(
                (r) =>
                    r.organizationId === org &&
                    terminalAt(r) &&
                    terminalAt(r)! < cutoff &&
                    !recentAlias(r) &&
                    !this.records.some(
                        (f) =>
                            f.organizationId === org &&
                            f.receiptId !== r.receiptId &&
                            f.findingIds.some((id) =>
                                r.findingIds.includes(id),
                            ) &&
                            (!terminalAt(f) ||
                                terminalAt(f)! >= cutoff ||
                                recentAlias(f)),
                    ),
            )
            .sort((a, b) => terminalAt(a)!.localeCompare(terminalAt(b)!))
            .slice(0, limit);
        const ids = new Set(rows.map((r) => r.receiptId));
        this.records = this.records.filter((r) => !ids.has(r.receiptId));
        for (const [key, a] of this.aliases)
            if (ids.has(a.receiptId)) this.aliases.delete(key);
        return ids.size;
    }
    async admit(input: ExternalSubmissionAdmission) {
        // No await: atomic fixture; PostgreSQL transaction semantics have separate tests.
        const { record, messageId, bodyHash } = input;
        const key = this.key(record.organizationId, record.keyId, messageId);
        const alias = this.aliases.get(key);
        if (alias && alias.bodyHash !== bodyHash)
            throw new ExternalAdmissionError('idempotency_conflict');
        const day = new Date(input.at);
        day.setUTCHours(0, 0, 0, 0);
        const messages = [...this.aliases.entries()].filter(([k, v]) => {
            const [o, ky] = JSON.parse(k);
            return (
                o === record.organizationId &&
                ky === record.keyId &&
                v.createdAt >= day.toISOString()
            );
        }).length;
        if (!alias && messages >= 4000)
            throw new ExternalAdmissionError('message_quota_exceeded');
        const found = this.records.find(
            (r) =>
                r.organizationId === record.organizationId &&
                r.keyId === record.keyId &&
                (r.fingerprint === record.fingerprint ||
                    r.receiptId === alias?.receiptId),
        );
        if (found) {
            if (!alias)
                this.aliases.set(key, {
                    receiptId: found.receiptId,
                    bodyHash,
                    createdAt: input.at,
                });
            return { record: found, deduplicated: true };
        }
        if (input.reuseOnly)
            throw new ExternalAdmissionError('receipt_expired');
        const since = new Date(record.createdAt);
        since.setUTCHours(0, 0, 0, 0);
        const rows = this.records.filter(
            (r) =>
                r.organizationId === record.organizationId &&
                r.createdAt >= since.toISOString(),
        );
        const keyCount = rows
            .filter((r) => r.keyId === record.keyId)
            .reduce((n, r) => n + r.findingIds.length, 0);
        const prCount = rows
            .filter(
                (r) =>
                    r.repositoryId === record.repositoryId &&
                    r.prNumber === record.prNumber,
            )
            .reduce((n, r) => n + r.findingIds.length, 0);
        if (
            keyCount + record.findingIds.length >
                EXTERNAL_FINDINGS_QUOTA.perKeyPerDay ||
            prCount + record.findingIds.length >
                EXTERNAL_FINDINGS_QUOTA.perPullRequestPerDay
        )
            throw new ExternalAdmissionError('quota_exceeded');
        this.records.push(structuredClone(record));
        this.aliases.set(key, {
            receiptId: record.receiptId,
            bodyHash,
            createdAt: input.at,
        });
        if (input.request) this.requests.push(structuredClone(input.request));
        return { record, deduplicated: false };
    }
}

export function externalFindingsFixture() {
    let at = new Date(NOW);
    let stopped = false;
    const principal: EnvKeyPrincipal = {
        organizationId: 'org-a',
        teamId: 'team-a',
        keyId: 'key-a',
        capabilities: ['findings:submit', 'env:exec'],
        repositoryIds: ['repo-a'],
    };
    const environment = {
        environmentId: randomUUID(),
        organizationId: 'org-a',
        teamId: 'team-a',
        repositoryId: 'repo-a',
        repositoryName: 'fixture/shop',
        state: 'active' as const,
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
    };
    const image = {
        ...environment,
        imageId: 'img-1',
        expose: [{ service: 'web', port: 3000, kind: 'http' as const }],
    };
    const products = {
        findByRepository: async (org: string, repo: string) =>
            org === environment.organizationId &&
            repo === environment.repositoryId
                ? environment
                : null,
    } as ProductEnvironmentStore;
    const environmentReader = {
        get: async (org: string, id: string) =>
            org === environment.organizationId &&
            id === environment.environmentId
                ? image
                : null,
    } satisfies RuntimeEnvironmentReader;
    let head = {
        headSha: SHA,
        baseSha: BASE_SHA,
        fork: false,
        state: 'open' as const,
    };
    const git = {
        getPullRequestHead: async () => head,
        getPullRequestDiff: async () => ({
            files: [
                {
                    path: 'server.js',
                    patch: '+app.get("/orders", handler)',
                    content: 'app.get("/orders", handler)',
                },
            ],
        }),
    } as unknown as RuntimeGitPort;
    const tokens: string[] = [];
    const issuer = {
        issue: async () => {
            tokens.push('fixture-token');
            return 'fixture-token';
        },
    };
    const builder = new RuntimeRunRequestBuilder(
        git,
        issuer,
        environmentReader,
        fixtureConfig(),
        () => at,
    );
    const runs = new InMemoryRunProjectionStore();
    const store = new InMemoryExternalFindingsStore();
    const stops = { isStopped: async () => stopped };
    const service = new ExternalFindingsService(
        store,
        products,
        git,
        environmentReader,
        runs,
        stops,
        builder,
        () => at,
    );
    const input = {
        repositoryId: 'repo-a',
        prNumber: 2,
        headSha: SHA,
        source: { name: 'fixture-agent', version: '1' },
        findings: [
            {
                title: 'orders response changed',
                severity: 'medium' as const,
                rationale: 'count differs',
                evidence: {
                    probe: {
                        id: 'client-id',
                        origin: 'external' as const,
                        purpose: 'count orders',
                        expected: 'same response',
                        compare: ['status' as const, 'json' as const],
                        spec: {
                            kind: 'http' as const,
                            target: { service: 'web', port: 3000 },
                            method: 'GET' as const,
                            path: '/orders',
                            timeoutMs: 1000,
                        },
                    },
                    observed: { verdict: 'finding', trusted: true },
                },
            },
        ],
    };
    return {
        service,
        store,
        runs,
        tokens,
        git,
        input,
        principal,
        environment,
        image,
        stops,
        setStopped: (v: boolean) => {
            stopped = v;
        },
        setHead: (v: Partial<typeof head>) => {
            head = { ...head, ...v };
        },
        now: () => at,
        advance: (ms: number) => {
            at = new Date(at.getTime() + ms);
        },
    };
}
