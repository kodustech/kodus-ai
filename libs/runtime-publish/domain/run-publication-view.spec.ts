import { publishKey } from '@libs/runtime/run';

import { runPublicationViewOf, type RunPublicationInput } from './run-publication-view';
import type { RuntimePublication } from './runtime-publication';

const RUN_ID = '0b9f4c1e-8d2a-4f6b-9a3c-1e2d3f4a5b6c';
const AT = '2026-10-31T14:10:00.000Z';

function row(key: string, patch: Partial<RuntimePublication> = {}): RuntimePublication {
    return {
        key,
        runId: RUN_ID,
        attempt: 1,
        kind: key.includes(':check') ? 'check' : 'comment',
        organizationId: 'org-a',
        teamId: 'team-a',
        repositoryId: 'repo-1',
        prNumber: 42,
        headSha: 'a'.repeat(40),
        status: 'published',
        createdAt: AT,
        updatedAt: AT,
        ...patch,
    };
}

const CHECK = publishKey(RUN_ID, 1, 'check');
const COMMENT = publishKey(RUN_ID, 1, 'comment');
const view = (rows: RuntimePublication[], patch: Partial<RunPublicationInput> = {}) =>
    runPublicationViewOf({ runId: RUN_ID, attempt: 1, state: 'partly_tested', postsToPullRequest: true, rows, ...patch });

describe('runPublicationViewOf', () => {
    it('a simulation posts nothing and never reads as published', () => {
        expect(view([row(CHECK, { checkRank: 3 }), row(COMMENT)], { postsToPullRequest: false })).toEqual({
            postsToPullRequest: false,
            check: { status: 'not_expected' },
            comment: { status: 'not_expected' },
            settled: true,
        });
    });

    it('published only when the product completed the final check and posted the report', () => {
        expect(view([row(CHECK, { checkRank: 3 }), row(COMMENT)])).toEqual({
            postsToPullRequest: true,
            check: { status: 'published', at: AT },
            comment: { status: 'published', at: AT },
            settled: true,
        });
    });

    it('kr-grafana#3: the check is done, the comment still shows the last progress phase', () => {
        const out = view([
            row(CHECK, { checkRank: 3 }),
            row(publishKey(RUN_ID, 1, 'comment', 'booting')),
            row(publishKey(RUN_ID, 1, 'comment', 'reporting')),
            row(COMMENT, { status: 'failed', reason: 'publication x is being published by another delivery' }),
        ]);
        expect(out.check.status).toBe('published');
        expect(out.comment).toEqual({ status: 'pending', at: AT, retrying: true, showing: 'reporting' });
        expect(out.settled).toBe(false);
    });

    it('no final row yet is pending, with what the PR shows; an open check is pending too', () => {
        const out = view([row(CHECK, { checkRank: 2 }), row(publishKey(RUN_ID, 1, 'comment', 'applying'))], { state: 'testing' });
        expect(out.check).toEqual({ status: 'pending', at: AT });
        expect(out.comment).toEqual({ status: 'pending', showing: 'applying' });
    });

    it('given up is failed; a failure message never reaches the view', () => {
        const out = view([
            row(CHECK, { status: 'failed', reason: 'HTTP 500: secret platform text', redrive: { attempts: 5, gaveUpAt: AT, gaveUpReason: 'attempts' } }),
            row(COMMENT, { fallback: true, redrive: { attempts: 6 } }),
        ]);
        expect(out.check).toEqual({ status: 'failed', at: AT, redriveAttempts: 5 });
        expect(out.comment).toEqual({ status: 'published', at: AT, redriveAttempts: 6, fallback: true });
        expect(JSON.stringify(out)).not.toContain('secret');
        expect(out.settled).toBe(true);
    });

    it('a skip shows its reason from a fixed set only', () => {
        const out = view([row(CHECK, { status: 'skipped', reason: 'checks_unavailable' }), row(COMMENT, { status: 'skipped', reason: 'something else' })]);
        expect(out.check).toEqual({ status: 'skipped', at: AT, reason: 'checks_unavailable' });
        expect(out.comment).toEqual({ status: 'skipped', at: AT });
    });

    it('a fork waiting shows its check; superseded and cancelled Runs expect no comment', () => {
        const waiting = view([row(publishKey(RUN_ID, 1, 'check', 'awaiting_approval'), { checkRank: 3 })], { state: 'awaiting_approval' });
        expect(waiting.check.status).toBe('published');
        expect(waiting.comment.status).toBe('not_expected');
        expect(waiting.settled).toBe(false);
        const superseded = view([row(CHECK, { checkRank: 3 })], { state: 'superseded' });
        expect(superseded).toMatchObject({ comment: { status: 'not_expected' }, settled: true });
    });

    it('rows of another attempt never count', () => {
        expect(view([row(CHECK, { checkRank: 3, attempt: 2 })]).check).toEqual({ status: 'pending' });
    });
});
