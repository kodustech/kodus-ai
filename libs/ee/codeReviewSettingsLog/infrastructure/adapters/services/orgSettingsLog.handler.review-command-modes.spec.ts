import { OrgSettingsLogHandler } from './orgSettingsLog.handler';

const handler = Object.create(
    OrgSettingsLogHandler.prototype,
) as OrgSettingsLogHandler;

const changes = (previous: unknown, current: unknown) =>
    (
        handler as never as {
            generateReviewCommandModesChanges: (
                p: unknown,
                c: unknown,
                email: string,
            ) => Array<{ actionDescription: string; description: string }>;
        }
    ).generateReviewCommandModesChanges(previous, current, 'owner@kodus.io');

describe('OrgSettingsLogHandler — review mode commands', () => {
    it('records each switch turned off, from nothing stored', () => {
        expect(
            changes(null, { heavyBlocked: true, ultraBlocked: true }).map(
                (c) => c.description,
            ),
        ).toEqual([
            'User owner@kodus.io turned off Heavy review by command',
            'User owner@kodus.io turned off Ultra review by command',
        ]);
    });

    it('records a switch turned back on, and nothing for one left alone', () => {
        expect(
            changes(
                { heavyBlocked: true, ultraBlocked: true },
                { heavyBlocked: true, ultraBlocked: false },
            ).map((c) => c.actionDescription),
        ).toEqual(['Ultra review by command turned on']);
    });
});
