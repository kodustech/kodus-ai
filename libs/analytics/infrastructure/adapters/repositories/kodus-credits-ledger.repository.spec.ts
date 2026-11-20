import { KodusCreditsLedgerRepository } from './kodus-credits-ledger.repository';

// A charge's state moves only from pending: a pass that lost the race to
// another one writes nothing over what that one settled.
describe('KodusCreditsLedgerRepository state writes', () => {
    const build = () => {
        const chargeModel = { updateMany: jest.fn(async () => ({})) };
        const repository = new KodusCreditsLedgerRepository(
            {} as any,
            chargeModel as any,
            {} as any,
        );
        return { repository, chargeModel };
    };

    it('marks only pending charges debited', async () => {
        const { repository, chargeModel } = build();
        const at = new Date('2026-11-20T00:00:00Z');

        await repository.markChargesDebited(['s1', 's2'], at);

        expect(chargeModel.updateMany).toHaveBeenCalledWith(
            { spanId: { $in: ['s1', 's2'] }, status: 'pending' },
            { $set: { status: 'debited', debitedAt: at } },
        );
    });

    it('records a debit error only on charges still pending', async () => {
        const { repository, chargeModel } = build();

        await repository.recordChargeError(['s1'], 'billing down');

        expect(chargeModel.updateMany).toHaveBeenCalledWith(
            { spanId: { $in: ['s1'] }, status: 'pending' },
            { $set: { lastError: 'billing down' } },
        );
    });
});
