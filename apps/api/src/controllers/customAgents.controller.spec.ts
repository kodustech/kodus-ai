import { AbilityBuilder, createMongoAbility } from '@casl/ability';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AppAbility } from '@libs/identity/domain/permissions/types/permissions.types';

import { CustomAgentsController } from './customAgents.controller';

// A member who can read code review settings of one repository only.
const abilityForRepo = (repoId: string): AppAbility => {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    can(Action.Read, ResourceType.CodeReviewSettings, {
        organizationId: 'org-1',
        repoId: { $in: [repoId] },
    } as any);
    return build();
};

const policiesOf = (handler: keyof CustomAgentsController) =>
    Reflect.getMetadata(
        'check_policy',
        CustomAgentsController.prototype[handler],
    ) as Array<(ability: AppAbility, request: any) => boolean>;

const user = { organization: { uuid: 'org-1' }, status: STATUS.ACTIVE };

describe('CustomAgentsController policies', () => {
    const ability = abilityForRepo('repo-a');

    it.each([
        ['resolve', (repositoryId: string) => ({ body: { repositoryId } })],
        ['status', (repositoryId: string) => ({ query: { repositoryId } })],
    ] as const)(
        '%s reads only a repository the member can read',
        (handler, requestFor) => {
            const allows = (repositoryId: string) =>
                policiesOf(handler).every((policy) =>
                    policy(ability, { user, ...requestFor(repositoryId) }),
                );

            expect(allows('repo-a')).toBe(true);
            expect(allows('repo-b')).toBe(false);
        },
    );
});
