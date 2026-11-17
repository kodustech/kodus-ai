import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/cockpit.service.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../../services/cockpit.service.js')
    >()),
    cockpitService: { getTab: vi.fn() },
}));

import { cockpitService } from '../../../services/cockpit.service.js';
import { cockpitTabAction } from '../command.js';

const base = {
    team: { id: 'team-1', name: 'Core' },
    range: { startDate: '2026-10-01', endDate: '2026-10-31' },
    repository: null,
    hidden: [],
};

function output(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map((call) => call.join(' ')).join('\n');
}

describe('cockpit terminal output', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('says a failed metric is unavailable instead of printing zeros', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.mocked(cockpitService.getTab).mockResolvedValue({
            ...base,
            tab: 'kodus-review',
            metrics: { implementationRateWeekly: null },
            errors: { implementationRateWeekly: 'Bad gateway' },
        });

        await cockpitTabAction('kodus-review', {});

        expect(output(log)).toContain('Suggestions: unavailable');
        expect(output(log)).not.toContain('0 sent');
    });

    it('does not report a failed intent or area read as empty data', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.mocked(cockpitService.getTab).mockResolvedValueOnce({
            ...base,
            tab: 'intent',
            metrics: { intent: null },
            errors: { intent: 'Bad gateway' },
        });
        vi.mocked(cockpitService.getTab).mockResolvedValueOnce({
            ...base,
            tab: 'code-areas',
            metrics: { areaRiskMap: { rankedAreaPaths: 'oops' } },
            errors: {},
        });

        await cockpitTabAction('intent', {});
        await cockpitTabAction('code-areas', {});

        expect(output(log)).toContain('unavailable right now');
        expect(output(log)).not.toContain('No pull requests were checked');
        // A non-array payload does not crash or print character by character.
        expect(output(log)).toContain('No code areas mapped');
    });
});
