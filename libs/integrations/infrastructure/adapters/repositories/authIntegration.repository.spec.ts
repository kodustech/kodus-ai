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
    });

    it('adds no authDetails condition when none is asked for', async () => {
        const { repository, find } = setup();

        await repository.find({ status: true } as any);

        expect(find.mock.calls[0][0].where).not.toHaveProperty('authDetails');
    });

    it('lets a database error through instead of answering "no links"', async () => {
        const find = jest.fn().mockRejectedValue(new Error('connection terminated'));
        const repository = new AuthIntegrationRepository({ find } as any);

        await expect(repository.find({ status: true } as any)).rejects.toThrow(
            'connection terminated',
        );
    });
});
