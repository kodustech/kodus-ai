import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';

import { PurgeRuntimeOrganizationUseCase } from '../application/use-cases/purge-organization.use-case';
import type { RuntimeOrganizationPurgeStore } from '../domain/organization-purge';
import { RuntimeSecretVaultUnavailableError } from '../domain/secrets';
import { OrganizationDeletedPurgeListener } from '../infrastructure/organization-deleted-purge.listener';
import { FakeOutbox, NOW } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));
const mockRuntimeEnabled = jest.fn(() => true);
jest.mock('@libs/runtime-publish/runtime-feature', () => ({ kodyRuntimeEnabledInThisProcess: () => mockRuntimeEnabled() }));

const ORG = 'org-purge-1';
const owner = { uuid: 'user-owner', email: 'owner@example.test', organization: { uuid: ORG } } as never;

/** The product rows and the vault of one organization, as the use case sees them. */
function setup(over: { secretIds?: string[]; vaultFails?: string[]; storeFails?: boolean } = {}) {
    const calls: string[] = [];
    const store: RuntimeOrganizationPurgeStore = {
        secretIds: async () => over.secretIds ?? ['db_password', 'npm_token'],
        purgeOrganization: async (org, opts) => {
            if (over.storeFails) throw new Error('product database down');
            calls.push(`rows ${org} keep=${(opts?.keepSecretIds ?? []).join(',')}`);
            return { runtime_environments: 2, runtime_secrets: 1 };
        },
    };
    const vault = {
        configured: true,
        write: jest.fn(),
        setHosts: jest.fn(),
        delete: jest.fn(async (org: string, id: string) => {
            if (over.vaultFails?.includes(id)) throw new RuntimeSecretVaultUnavailableError('delete answered 503');
            calls.push(`vault ${org}/${id}`);
        }),
    };
    const outbox = new FakeOutbox();
    const original = outbox.create.bind(outbox);
    outbox.create = async (row: unknown) => {
        calls.push('outbox');
        return original(row);
    };
    const useCase = new PurgeRuntimeOrganizationUseCase(store, vault, outbox, () => NOW);
    return { useCase, calls, vault, outbox };
}

describe('PurgeRuntimeOrganizationUseCase', () => {
    it('deletes the secrets of the org, then its product rows, then sends the Runtime the command', async () => {
        const { useCase, calls, outbox } = setup();

        const out = await useCase.execute({ organizationId: ORG, reason: 'organization_deleted' });

        expect(calls).toEqual([`vault ${ORG}/db_password`, `vault ${ORG}/npm_token`, `rows ${ORG} keep=`, 'outbox']);
        expect(out).toEqual({ organizationId: ORG, requestedAt: NOW.toISOString(), secretsDeleted: 2, productRows: 3 });
        expect(outbox.events).toEqual([RuntimeCommandName.OrganizationPurgeRequested]);
        expect(outbox.rows[0].payload.payload).toEqual({
            organizationId: ORG,
            requestedAt: NOW.toISOString(),
            reason: 'organization_deleted',
            workflowType: 'RUNTIME_CONTROL',
        });
    });

    it('is idempotent: a second run finds no secret, deletes nothing and sends the command again', async () => {
        const { useCase, outbox } = setup({ secretIds: [] });
        await useCase.execute({ organizationId: ORG, reason: 'organization_deleted' });
        await expect(useCase.execute({ organizationId: ORG, reason: 'organization_deleted' })).resolves.toMatchObject({ secretsDeleted: 0 });
        expect(outbox.rows).toHaveLength(2);
    });

    it('keeps the metadata of a secret the store would not delete, still requests the rest, and answers 503 so the purge is run again', async () => {
        const { useCase, calls, outbox } = setup({ vaultFails: ['npm_token'] });

        await expect(useCase.execute({ organizationId: ORG, reason: 'owner_requested' })).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(calls).toEqual([`vault ${ORG}/db_password`, `rows ${ORG} keep=npm_token`, 'outbox']);
        expect(outbox.events).toEqual([RuntimeCommandName.OrganizationPurgeRequested]);
    });

    it('sends nothing to the Runtime when the product rows cannot be deleted, so the caller sees the failure', async () => {
        const { useCase, outbox } = setup({ storeFails: true });
        await expect(useCase.execute({ organizationId: ORG, reason: 'organization_deleted' })).rejects.toThrow('product database down');
        expect(outbox.rows).toEqual([]);
    });

    describe('the explicit purge', () => {
        it("takes the caller's own org and the id it typed, and records who asked", async () => {
            const { useCase, outbox } = setup();
            await useCase.executeConfirmed({ user: owner, confirm: ORG });
            expect(outbox.rows[0].payload.payload).toMatchObject({ organizationId: ORG, reason: 'owner_requested', requestedBy: { userId: 'user-owner', email: 'owner@example.test' } });
        });

        it.each([[undefined], [''], ['org-other'], [`${ORG} `], [ORG.toUpperCase()], [[ORG]], [{ id: ORG }], [null]])('refuses the confirmation %j before touching anything', async (confirm) => {
            const { useCase, calls, outbox } = setup();
            await expect(useCase.executeConfirmed({ user: owner, confirm })).rejects.toBeInstanceOf(BadRequestException);
            expect(calls).toEqual([]);
            expect(outbox.rows).toEqual([]);
        });

        it('refuses a caller with no organization', async () => {
            const { useCase } = setup();
            await expect(useCase.executeConfirmed({ user: { uuid: 'u' } as never, confirm: ORG })).rejects.toBeInstanceOf(NotFoundException);
            await expect(useCase.executeConfirmed({ user: { organization: { uuid: ORG } } as never, confirm: ORG })).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});

describe('OrganizationDeletedPurgeListener', () => {
    const event = { organizationId: ORG };
    const listenerOf = (execute: jest.Mock) => {
        const listener = new OrganizationDeletedPurgeListener({ execute } as unknown as PurgeRuntimeOrganizationUseCase);
        listener.delaysMs = [0, 0, 0];
        return listener;
    };
    beforeEach(() => mockRuntimeEnabled.mockReturnValue(true));

    it('purges the deleted org as an organization deletion', async () => {
        const execute = jest.fn(async () => ({}));
        await listenerOf(execute).handle(event);
        expect(execute).toHaveBeenCalledWith({ organizationId: ORG, reason: 'organization_deleted' });
    });

    it('tries again after a failure, then stops, and never throws into the deletion that emitted it', async () => {
        const failing = jest.fn(async () => {
            throw new Error('secret store down');
        });
        await expect(listenerOf(failing).handle(event)).resolves.toBeUndefined();
        expect(failing).toHaveBeenCalledTimes(3);

        const flaky = jest.fn().mockRejectedValueOnce(new Error('blink')).mockResolvedValue({});
        await listenerOf(flaky).handle(event);
        expect(flaky).toHaveBeenCalledTimes(2);
    });

    it('does nothing in a deployment without the Runtime, or for an event with no org', async () => {
        const execute = jest.fn();
        mockRuntimeEnabled.mockReturnValue(false);
        await listenerOf(execute).handle(event);
        mockRuntimeEnabled.mockReturnValue(true);
        await listenerOf(execute).handle({ organizationId: '' });
        expect(execute).not.toHaveBeenCalled();
    });
});
