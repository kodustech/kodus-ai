import { FindOverrideCountsByRepositoryPullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/find-override-counts-by-repository.use-case';
import { PullRequestMessagesEntity } from '@libs/code-review/domain/pullRequestMessages/entities/pullRequestMessages.entity';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import {
    ConfigLevel,
    PullRequestMessageStatus,
} from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';

const user = { organization: { uuid: 'org-1' } } as any;
const message = (content: string) => ({
    content,
    status: PullRequestMessageStatus.EVERY_PUSH,
});
const entity = (
    configLevel: ConfigLevel,
    fields: Partial<IPullRequestMessages>,
) =>
    PullRequestMessagesEntity.create({
        organizationId: 'org-1',
        configLevel,
        ...fields,
    });
const entities = [
    entity(ConfigLevel.GLOBAL, { startReviewMessage: message('Global start') }),
    entity(ConfigLevel.REPOSITORY, {
        repositoryId: 'repo-a',
        startReviewMessage: message('Repository start'),
    }),
    entity(ConfigLevel.DIRECTORY, {
        repositoryId: 'repo-a',
        directoryId: 'dir-a',
        startReviewMessage: message('Directory start'),
    }),
    entity(ConfigLevel.REPOSITORY, {
        repositoryId: 'repo-b',
        startReviewMessage: message('Global start'),
    }),
    entity(ConfigLevel.DIRECTORY, {
        repositoryId: 'repo-c',
        directoryId: 'dir-c',
        startReviewMessage: message('Directory only'),
    }),
];

function build(scope: string[] | null = null, data = entities) {
    const matches = (
        filter: Record<string, unknown>,
        item: PullRequestMessagesEntity,
    ) =>
        Object.entries(filter).every(
            ([key, value]) => item.toJson()[key] === value,
        );
    const service = {
        find: jest.fn(async (filter) =>
            data.filter((item) => matches(filter, item)),
        ),
        findOne: jest.fn(
            async (filter) =>
                data.find((item) => matches(filter, item)) ?? null,
        ),
    };
    const authorization = {
        getRepositoryScope: jest.fn().mockResolvedValue(scope),
    };
    return {
        useCase: new FindOverrideCountsByRepositoryPullRequestMessagesUseCase(
            service as any,
            authorization as any,
        ),
        service,
        authorization,
    };
}

describe('custom message override counts for all repositories', () => {
    it('preserves repository/directory inheritance and includes directory-only repositories', async () => {
        const { useCase, service, authorization } = build();
        expect(await useCase.executeAll(user)).toEqual([
            {
                repositoryId: 'repo-a',
                repositoryOverrideCount: 1,
                directoryOverrideCounts: [
                    { directoryId: 'dir-a', overrideCount: 1 },
                ],
            },
            {
                repositoryId: 'repo-b',
                repositoryOverrideCount: 0,
                directoryOverrideCounts: [],
            },
            {
                repositoryId: 'repo-c',
                repositoryOverrideCount: 0,
                directoryOverrideCounts: [
                    { directoryId: 'dir-c', overrideCount: 1 },
                ],
            },
        ]);
        expect(service.find).toHaveBeenCalledTimes(1);
        expect(service.find).toHaveBeenCalledWith({ organizationId: 'org-1' });
        expect(service.findOne).not.toHaveBeenCalled();
        expect(authorization.getRepositoryScope).toHaveBeenCalledWith({
            user,
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        });
    });

    it('matches the existing per-repository endpoint', async () => {
        const { useCase } = build();
        const counts = await useCase.executeAll(user);
        for (const count of counts) {
            expect(await useCase.execute('org-1', count.repositoryId)).toEqual(
                count,
            );
        }
    });

    it('keeps one database read with 100 repositories', async () => {
        const data = Array.from({ length: 100 }, (_, index) =>
            entity(ConfigLevel.REPOSITORY, {
                repositoryId: `repo-${index}`,
                startReviewMessage: message('Custom'),
            }),
        );
        const { useCase, service } = build(null, data);
        expect(await useCase.executeAll(user)).toHaveLength(100);
        expect(service.find).toHaveBeenCalledTimes(1);
        expect(service.findOne).not.toHaveBeenCalled();
    });

    it("does not return counts outside the caller's repository scope", async () => {
        const { useCase } = build(['repo-c']);
        expect(await useCase.executeAll(user)).toEqual([
            {
                repositoryId: 'repo-c',
                repositoryOverrideCount: 0,
                directoryOverrideCounts: [
                    { directoryId: 'dir-c', overrideCount: 1 },
                ],
            },
        ]);
    });

    it('does not read messages for an empty permission scope', async () => {
        const { useCase, service } = build([]);
        expect(await useCase.executeAll(user)).toEqual([]);
        expect(service.find).not.toHaveBeenCalled();
    });

    it('requires an organization before reading data or permissions', async () => {
        const { useCase, service, authorization } = build();
        await expect(useCase.executeAll(undefined)).rejects.toThrow(
            'Organization ID is required',
        );
        expect(service.find).not.toHaveBeenCalled();
        expect(authorization.getRepositoryScope).not.toHaveBeenCalled();
    });

    it('returns no counts for a different organization', async () => {
        const { useCase } = build();
        expect(
            await useCase.executeAll({
                organization: { uuid: 'org-2' },
            } as any),
        ).toEqual([]);
    });

    it('propagates permission lookup failures without querying messages', async () => {
        const { useCase, service, authorization } = build();
        authorization.getRepositoryScope.mockRejectedValue(
            new Error('Permission lookup failed'),
        );
        await expect(useCase.executeAll(user)).rejects.toThrow(
            'Permission lookup failed',
        );
        expect(service.find).not.toHaveBeenCalled();
    });
});
