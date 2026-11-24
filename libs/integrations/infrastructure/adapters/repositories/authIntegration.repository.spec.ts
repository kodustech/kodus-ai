import { FindOperator } from 'typeorm';

import { AuthIntegrationRepository } from './authIntegration.repository';

/**
 * find() matches authDetails by JSON containment, as findOne() does, and
 * loads each row's organization, so a caller can see every organization an
 * installation is linked to (the GitHub App "linked to another
 * organization" check reads them all).
 */
describe('AuthIntegrationRepository.find', () => {
    const setup = () => {
        const find = jest.fn().mockResolvedValue([]);
        const repository = new AuthIntegrationRepository({ find } as any);
        return { repository, find };
    };

    it('filters authDetails by containment and loads the organization', async () => {
        const { repository, find } = setup();

        await repository.find({
            authDetails: { installationId: 4242 },
            status: true,
        } as any);

        const options = find.mock.calls[0][0];
        expect(options.relations).toEqual(['organization']);
        expect(options.where.status).toBe(true);
        const condition = options.where.authDetails as FindOperator<unknown>;
        expect(condition).toBeInstanceOf(FindOperator);
        expect(condition.type).toBe('raw');
        expect(condition.objectLiteralParameters).toEqual({
            authDetails: JSON.stringify({ installationId: 4242 }),
        });
        // JSON containment: the stored details hold the asked ones.
        expect(condition.getSql?.('ai.auth_details')).toBe(
            'ai.auth_details @> :authDetails',
        );
    });

    it('adds no authDetails condition when none is asked for', async () => {
        const { repository, find } = setup();

        await repository.find({ status: true } as any);
        await repository.find({ status: true, authDetails: {} } as any);

        expect(find.mock.calls[0][0].where).not.toHaveProperty('authDetails');
        expect(find.mock.calls[1][0].where).not.toHaveProperty('authDetails');
    });

    // The GitHub App link check reads every row's organization: one entity
    // per row, each with its organization, or the check never fires.
    it('returns one entity per row, each with its organization', async () => {
        const rows = [
            { uuid: 'ai-1', status: true, organization: { uuid: 'org-1' } },
            { uuid: 'ai-2', status: true, organization: { uuid: 'org-2' } },
        ];
        const repository = new AuthIntegrationRepository({
            find: jest.fn().mockResolvedValue(rows),
        } as any);

        const found = await repository.find({ status: true } as any);

        expect(found).toHaveLength(2);
        expect(found.map((e) => e.uuid)).toEqual(['ai-1', 'ai-2']);
        expect(found.map((e) => e.organization?.uuid)).toEqual([
            'org-1',
            'org-2',
        ]);
    });

    it('returns an empty list when no row matches', async () => {
        const repository = new AuthIntegrationRepository({
            find: jest.fn().mockResolvedValue([]),
        } as any);

        await expect(repository.find({ status: true } as any)).resolves.toEqual(
            [],
        );
    });

    it('lets a database error through instead of answering "no links"', async () => {
        const find = jest
            .fn()
            .mockRejectedValue(new Error('connection terminated'));
        const repository = new AuthIntegrationRepository({ find } as any);

        await expect(repository.find({ status: true } as any)).rejects.toThrow(
            'connection terminated',
        );
    });
});
