import { Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import type { IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import {
    RuntimeEventName,
    RuntimeRunRequestedSchema,
    runtimeRunOutboxMessage,
} from '@libs/runtime/run/run-messages';
import {
    canonicalExternalJSON,
    ExternalAdmissionError,
    EXTERNAL_FINDINGS_QUOTA,
    type ExternalFindingsStore,
    type ExternalSubmissionAdmission,
    type ExternalSubmissionRecord,
} from '../domain/external-findings';

const messageQuery = `SELECT s.record,k.body_hash FROM runtime_external_message_keys k JOIN runtime_external_submissions s ON s.receipt_id=k.receipt_id AND s.organization_id=k.organization_id WHERE k.organization_id=$1 AND k.key_id=$2 AND k.message_id=$3 LIMIT 1`;
const fingerprintQuery = `SELECT record FROM runtime_external_submissions WHERE organization_id=$1 AND key_id=$2 AND fingerprint=$3 LIMIT 1`;

function validateRequest(input: ExternalSubmissionAdmission): void {
    if (!input.request) return;
    const req = RuntimeRunRequestedSchema.parse(input.request);
    const r = input.record;
    const verification = req.externalVerification;
    if (
        r.refusal ||
        req.trigger !== 'external_finding' ||
        req.runId !== r.runId ||
        req.organizationId !== r.organizationId ||
        req.teamId !== r.teamId ||
        req.repository.id !== r.repositoryId ||
        req.pullRequest.number !== r.prNumber ||
        req.pullRequest.headSha !== r.headSha ||
        req.environment.imageId !== r.imageId ||
        !verification ||
        verification.taskId !== r.verificationTaskId ||
        verification.findings.some(
            (finding) => !r.findingIds.includes(finding.findingId),
        )
    )
        throw new Error('External Run is not bound to its product admission');
    const expected = r.submission.findings.flatMap((f, index) =>
        f.evidence?.probe
            ? [
                  {
                      findingId: r.findingIds[index],
                      probe: {
                          ...f.evidence.probe,
                          id: r.findingIds[index],
                          origin: 'external',
                      },
                  },
              ]
            : [],
    );
    if (
        canonicalExternalJSON(expected) !==
        canonicalExternalJSON(verification.findings)
    )
        throw new Error('External Run probes differ from admitted findings');
}

/** One product transaction owns durable receipt/task, key aliases, quota and outbox. */
@Injectable()
export class TypeOrmExternalFindingsStore implements ExternalFindingsStore {
    constructor(
        private readonly source: Pick<DataSource, 'query' | 'transaction'>,
        private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
    ) {}

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
        const counts = (
            await this.source.query(
                `SELECT COALESCE(sum(finding_count) FILTER(WHERE key_id=$2),0) AS key_count,COALESCE(sum(finding_count) FILTER(WHERE repository_id=$3 AND pr_number=$4),0) AS pr_count,(SELECT count(*) FROM runtime_external_message_keys WHERE organization_id=$1 AND key_id=$2 AND created_at >= $5) AS message_count FROM runtime_external_submissions WHERE organization_id=$1 AND created_at >= $5`,
                [org, key, repo, pr, since],
            )
        )[0];
        return (
            Number(counts?.key_count ?? 0) + amount <=
                EXTERNAL_FINDINGS_QUOTA.perKeyPerDay &&
            Number(counts?.pr_count ?? 0) + amount <=
                EXTERNAL_FINDINGS_QUOTA.perPullRequestPerDay &&
            Number(counts?.message_count ?? 0) <
                EXTERNAL_FINDINGS_QUOTA.messagesPerKeyPerDay
        );
    }
    async byMessage(org: string, key: string, message: string) {
        const rows = await this.source.query(messageQuery, [org, key, message]);
        return rows[0]
            ? {
                  record: rows[0].record as ExternalSubmissionRecord,
                  bodyHash: rows[0].body_hash as string,
              }
            : null;
    }
    async byFingerprint(
        org: string,
        key: string,
        fingerprint: string,
    ): Promise<ExternalSubmissionRecord | null> {
        return (
            (
                await this.source.query(fingerprintQuery, [
                    org,
                    key,
                    fingerprint,
                ])
            )[0]?.record ?? null
        );
    }
    async byTask(
        org: string,
        task: string,
    ): Promise<ExternalSubmissionRecord | null> {
        return (
            (
                await this.source.query(
                    `SELECT record FROM runtime_external_submissions WHERE organization_id=$1 AND (receipt_id=$2 OR verification_task_id=$2) LIMIT 1`,
                    [org, task],
                )
            )[0]?.record ?? null
        );
    }
    async byFinding(
        org: string,
        finding: string,
    ): Promise<ExternalSubmissionRecord | null> {
        return (
            (
                await this.source.query(
                    `SELECT record FROM runtime_external_submissions WHERE organization_id=$1 AND finding_ids @> ARRAY[$2]::uuid[] ORDER BY (record->>'attempt')::integer DESC,created_at DESC,receipt_id DESC LIMIT 1`,
                    [org, finding],
                )
            )[0]?.record ?? null
        );
    }
    async complete(
        org: string,
        task: string,
        terminal: NonNullable<ExternalSubmissionRecord['terminal']>,
    ): Promise<ExternalSubmissionRecord> {
        await this.source.query(
            `UPDATE runtime_external_submissions SET record=jsonb_set(record,'{terminal}',$3::jsonb),terminal_at=$4 WHERE organization_id=$1 AND verification_task_id=$2 AND record->'terminal' IS NULL`,
            [org, task, JSON.stringify(terminal), terminal.updatedAt],
        );
        const result = await this.byTask(org, task);
        if (!result) throw new ExternalAdmissionError('receipt_expired');
        return result;
    }
    async listExpiredTaskIds(
        org: string,
        at: string,
        limit: number,
    ): Promise<string[]> {
        this.maintenanceInput(org, at, limit);
        return this.source.transaction(async (manager) => {
            await manager.query(
                "SET LOCAL statement_timeout='750ms'; SET LOCAL lock_timeout='200ms'",
            );
            const rows = await manager.query(
                `SELECT verification_task_id FROM runtime_external_submissions WHERE organization_id=$1 AND terminal_at IS NULL AND expires_at <= $2 ORDER BY expires_at,receipt_id LIMIT $3`,
                [org, at, limit],
            );
            return rows.map(
                (r: { verification_task_id: string }) => r.verification_task_id,
            );
        });
    }

    async purgeTerminal(
        org: string,
        cutoff: string,
        limit: number,
    ): Promise<number> {
        this.maintenanceInput(org, cutoff, limit);
        return this.source.transaction(async (manager) => {
            await manager.query(
                "SET LOCAL statement_timeout='750ms'; SET LOCAL lock_timeout='200ms'",
            );
            // Same key as admission, but maintenance must not wait behind a hot org.
            const lock = await manager.query(
                'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
                [org],
            );
            if (!lock[0]?.acquired) return 0;
            const rows = await manager.query(
                `WITH eligible AS (
                SELECT s.receipt_id FROM runtime_external_submissions s
                WHERE s.organization_id=$1 AND s.terminal_at < $2
                  AND NOT EXISTS(SELECT 1 FROM runtime_external_message_keys a WHERE a.organization_id=$1 AND a.receipt_id=s.receipt_id AND a.created_at >= $2)
                  AND NOT EXISTS(SELECT 1 FROM runtime_external_submissions family
                    WHERE family.organization_id=$1 AND family.receipt_id<>s.receipt_id AND family.finding_ids && s.finding_ids
                      AND (family.terminal_at IS NULL OR family.terminal_at >= $2 OR EXISTS(
                        SELECT 1 FROM runtime_external_message_keys a WHERE a.organization_id=$1 AND a.receipt_id=family.receipt_id AND a.created_at >= $2)))
                ORDER BY s.terminal_at,s.receipt_id LIMIT $3 FOR UPDATE OF s SKIP LOCKED
            ), deleted AS (DELETE FROM runtime_external_submissions s USING eligible e
              WHERE s.organization_id=$1 AND s.receipt_id=e.receipt_id RETURNING s.receipt_id)
              SELECT count(*)::int AS removed FROM deleted`,
                [org, cutoff, limit],
            );
            return Number(rows[0]?.removed ?? 0);
        });
    }

    private maintenanceInput(org: string, at: string, limit: number): void {
        if (
            !org ||
            !Number.isFinite(Date.parse(at)) ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100
        )
            throw new RangeError('Invalid external maintenance window');
    }

    async admit(input: ExternalSubmissionAdmission) {
        validateRequest(input);
        return this.source.transaction(async (manager) => {
            const r = input.record;
            // A per-org lock serializes both key and PR quota scopes; never a global lock.
            await manager.query(
                `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
                [r.organizationId],
            );
            const byMessage = (
                await manager.query(messageQuery, [
                    r.organizationId,
                    r.keyId,
                    input.messageId,
                ])
            )[0];
            if (byMessage) {
                if (byMessage.body_hash !== input.bodyHash)
                    throw new ExternalAdmissionError('idempotency_conflict');
                return {
                    record: byMessage.record as ExternalSubmissionRecord,
                    deduplicated: true,
                };
            }
            const since = new Date(input.at);
            since.setUTCHours(0, 0, 0, 0);
            const messages = (
                await manager.query(
                    `SELECT count(*) AS message_count FROM runtime_external_message_keys WHERE organization_id=$1 AND key_id=$2 AND created_at >= $3`,
                    [r.organizationId, r.keyId, since],
                )
            )[0];
            if (
                Number(messages?.message_count ?? 0) >=
                EXTERNAL_FINDINGS_QUOTA.messagesPerKeyPerDay
            )
                throw new ExternalAdmissionError('message_quota_exceeded');
            const duplicate = (
                await manager.query(fingerprintQuery, [
                    r.organizationId,
                    r.keyId,
                    r.fingerprint,
                ])
            )[0];
            if (duplicate) {
                await this.alias(manager, input, duplicate.record.receiptId);
                return {
                    record: duplicate.record as ExternalSubmissionRecord,
                    deduplicated: true,
                };
            }
            if (input.reuseOnly)
                throw new ExternalAdmissionError('receipt_expired');
            if (r.runId && !input.request)
                throw new Error(
                    'An executable task requires its atomic Run request',
                );

            const counts = (
                await manager.query(
                    `SELECT COALESCE(sum(finding_count) FILTER(WHERE key_id=$2),0) AS key_count,COALESCE(sum(finding_count) FILTER(WHERE repository_id=$3 AND pr_number=$4),0) AS pr_count FROM runtime_external_submissions WHERE organization_id=$1 AND created_at >= $5`,
                    [
                        r.organizationId,
                        r.keyId,
                        r.repositoryId,
                        r.prNumber,
                        since,
                    ],
                )
            )[0];
            const amount = r.findingIds.length;
            if (
                Number(counts?.key_count ?? 0) + amount >
                    EXTERNAL_FINDINGS_QUOTA.perKeyPerDay ||
                Number(counts?.pr_count ?? 0) + amount >
                    EXTERNAL_FINDINGS_QUOTA.perPullRequestPerDay
            )
                throw new ExternalAdmissionError('quota_exceeded');
            await manager.query(
                `INSERT INTO runtime_external_submissions(receipt_id,verification_task_id,organization_id,key_id,repository_id,pr_number,fingerprint,finding_ids,finding_count,created_at,record,expires_at,terminal_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
                [
                    r.receiptId,
                    r.verificationTaskId,
                    r.organizationId,
                    r.keyId,
                    r.repositoryId,
                    r.prNumber,
                    r.fingerprint,
                    r.findingIds,
                    amount,
                    r.createdAt,
                    JSON.stringify(r),
                    r.expiresAt,
                    r.terminal?.updatedAt ?? (r.refusal ? r.createdAt : null),
                ],
            );
            await this.alias(manager, input, r.receiptId);
            if (input.request)
                await this.outbox.create(
                    runtimeRunOutboxMessage(
                        input.request,
                        RuntimeEventName.RunRequested,
                        input.request.runId,
                    ),
                    manager,
                );
            return { record: r, deduplicated: false };
        });
    }
    private alias(
        manager: EntityManager,
        input: ExternalSubmissionAdmission,
        receiptId: string,
    ) {
        return manager.query(
            `INSERT INTO runtime_external_message_keys(organization_id,key_id,message_id,body_hash,receipt_id,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
            [
                input.record.organizationId,
                input.record.keyId,
                input.messageId,
                input.bodyHash,
                receiptId,
                input.at,
            ],
        );
    }
}
