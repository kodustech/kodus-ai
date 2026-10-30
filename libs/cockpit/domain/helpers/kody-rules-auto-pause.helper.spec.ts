import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { KodyRuleUsageRow } from '../types';
import {
    AUTO_PAUSE_WINDOW_DAYS,
    autoPauseWindowStart,
    decideAutoPause,
} from './kody-rules-auto-pause.helper';

const usage = (over: Partial<KodyRuleUsageRow> = {}): KodyRuleUsageRow => ({
    ruleId: 'r1',
    triggers: 10,
    implemented: 5,
    rate: 0.5,
    thumbsUp: 0,
    thumbsDown: 0,
    lastTriggeredAt: null,
    ...over,
});

const IGNORED = usage({ triggers: 14, implemented: 2, rate: 0.14 });
const NOISY = usage({
    triggers: 20,
    implemented: 10,
    rate: 0.5,
    thumbsDown: 5,
});
// Both signals: the classifier reports `noisy`, which still pauses.
const NOISY_AND_IGNORED = usage({
    triggers: 20,
    implemented: 1,
    rate: 0.05,
    thumbsDown: 5,
});

const active = { status: KodyRulesStatus.ACTIVE };

describe('decideAutoPause', () => {
    it.each([
        ['ignored', IGNORED, 'ignored'],
        ['noisy', NOISY, 'noisy'],
        ['noisy and ignored', NOISY_AND_IGNORED, 'noisy'],
    ])('pauses a rule that is %s', (_label, row, state) => {
        expect(
            decideAutoPause({
                rule: active,
                usage: row,
                settingOn: true,
                centralized: false,
            }),
        ).toEqual({ action: 'pause', state });
    });

    it.each([
        ['healthy', usage()],
        ['low on data', usage({ triggers: 3, implemented: 0, rate: 0 })],
        ['stale', undefined],
    ])('leaves a %s rule alone', (_label, row) => {
        expect(
            decideAutoPause({
                rule: active,
                usage: row,
                settingOn: true,
                centralized: false,
            }),
        ).toEqual({ action: 'skip', reason: 'healthy' });
    });

    it('does nothing with the setting off', () => {
        expect(
            decideAutoPause({
                rule: active,
                usage: IGNORED,
                settingOn: false,
                centralized: false,
            }),
        ).toEqual({ action: 'skip', reason: 'setting_off' });
    });

    it('never touches a rule kept in a config repository', () => {
        expect(
            decideAutoPause({
                rule: active,
                usage: IGNORED,
                settingOn: true,
                centralized: true,
            }),
        ).toEqual({ action: 'skip', reason: 'centralized_config' });
    });

    it.each([
        KodyRulesStatus.PAUSED,
        KodyRulesStatus.PENDING,
        KodyRulesStatus.DELETED,
    ])('only acts on active rules (%s is skipped)', (status) => {
        expect(
            decideAutoPause({
                rule: { status },
                usage: IGNORED,
                settingOn: true,
                centralized: false,
            }),
        ).toEqual({ action: 'skip', reason: 'not_active' });
    });
});

describe('autoPauseWindowStart', () => {
    const now = new Date('2026-10-20T06:00:00Z');
    const fullWindow = new Date(
        now.getTime() - AUTO_PAUSE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    it('looks back the full window for a rule never resumed', () => {
        expect(autoPauseWindowStart(now, undefined)).toEqual(fullWindow);
        expect(autoPauseWindowStart(now, null)).toEqual(fullWindow);
    });

    it('starts at the resume when it falls inside the window', () => {
        const resumedAt = new Date('2026-10-15T12:00:00Z');
        expect(autoPauseWindowStart(now, resumedAt)).toEqual(resumedAt);
    });

    it('ignores a resume older than the window', () => {
        expect(
            autoPauseWindowStart(now, new Date('2026-01-01T00:00:00Z')),
        ).toEqual(fullWindow);
    });

    it('accepts the resume as stored in Mongo (string)', () => {
        expect(
            autoPauseWindowStart(
                now,
                '2026-10-15T12:00:00.000Z' as unknown as Date,
            ),
        ).toEqual(new Date('2026-10-15T12:00:00Z'));
    });
});
