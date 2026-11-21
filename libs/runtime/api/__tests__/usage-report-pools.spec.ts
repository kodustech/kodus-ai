import { PgRuntimeUsageReportReader } from '../infrastructure/pg-runtime-usage-report.reader';

// The usage report's reads take up to 15 s and run on the reports' pool of 3.
// The Preview settings screen reads one indexed month of preview claims
// (under a millisecond): it runs on the screens' pool, so opening the screen
// never waits behind three owners' reports (perf N1).
describe('PgRuntimeUsageReportReader pools', () => {
    const pool = () => ({ query: jest.fn(async () => ({ rows: [{ total: 0, refused: 0, n: 0 }] })) });
    const month = { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') };

    it("reads a month's preview claims on the screens' pool", async () => {
        const reports = pool(), screens = pool();
        await new PgRuntimeUsageReportReader(reports, screens).previewClaimsOfMonth('org-1', month, 10);
        expect(screens.query).toHaveBeenCalledTimes(1);
        expect(reports.query).not.toHaveBeenCalled();
    });

    it("keeps the month's runs and sandbox operations on the reports' pool", async () => {
        const reports = pool(), screens = pool();
        const reader = new PgRuntimeUsageReportReader(reports, screens);
        await reader.runsOfMonth('org-1', month, {}, 10);
        await reader.sandboxOperationsOfMonth('org-1', month);
        expect(reports.query).toHaveBeenCalled();
        expect(screens.query).not.toHaveBeenCalled();
    });
});
