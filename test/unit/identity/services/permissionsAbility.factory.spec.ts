import { subject } from '@casl/ability';

import {
    SubscriptionStatus,
    type ILicenseService,
} from '@libs/ee/license/interfaces/license.interface';
import { type IPermissionsService } from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import {
    Action,
    ResourceType,
    Role,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { type IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

const ORG_ID = 'org-1';
const ASSIGNED_REPO_ID = 'repo-1';
const OTHER_REPO_ID = 'repo-2';

const permissionsServiceMock: Pick<IPermissionsService, 'findOne'> = {
    findOne: jest.fn(),
};

const createLicenseServiceMock = (
    subscriptionStatus: SubscriptionStatus,
): Pick<ILicenseService, 'validateOrganizationLicense'> => ({
    validateOrganizationLicense: jest.fn().mockResolvedValue({
        valid: true,
        subscriptionStatus,
    }),
});

const createUser = (role: Role): IUser => ({
    uuid: `user-${role}`,
    password: 'secret',
    email: `${role}@kodus.io`,
    status: STATUS.ACTIVE,
    role,
    organization: {
        uuid: ORG_ID,
    },
});

const abilityChecks = [
    {
        label: 'manage all',
        action: Action.Manage,
        resource: ResourceType.All,
    },
    {
        label: 'read billing',
        action: Action.Read,
        resource: subject(ResourceType.Billing, { organizationId: ORG_ID }),
    },
    {
        label: 'manage billing',
        action: Action.Manage,
        resource: subject(ResourceType.Billing, { organizationId: ORG_ID }),
    },
    {
        label: 'read code review settings global',
        action: Action.Read,
        resource: subject(ResourceType.CodeReviewSettings, {
            organizationId: ORG_ID,
            repoId: 'global',
        }),
    },
    {
        label: 'update code review settings assigned repo',
        action: Action.Update,
        resource: subject(ResourceType.CodeReviewSettings, {
            organizationId: ORG_ID,
            repoId: ASSIGNED_REPO_ID,
        }),
    },
    {
        label: 'update code review settings global',
        action: Action.Update,
        resource: subject(ResourceType.CodeReviewSettings, {
            organizationId: ORG_ID,
            repoId: 'global',
        }),
    },
    {
        label: 'read kody rules global',
        action: Action.Read,
        resource: subject(ResourceType.KodyRules, {
            organizationId: ORG_ID,
            repoId: 'global',
        }),
    },
    {
        label: 'delete kody rules assigned repo',
        action: Action.Delete,
        resource: subject(ResourceType.KodyRules, {
            organizationId: ORG_ID,
            repoId: ASSIGNED_REPO_ID,
        }),
    },
    {
        label: 'update kody rules global',
        action: Action.Update,
        resource: subject(ResourceType.KodyRules, {
            organizationId: ORG_ID,
            repoId: 'global',
        }),
    },
    {
        label: 'read issues org',
        action: Action.Read,
        resource: subject(ResourceType.Issues, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'read issues assigned repo',
        action: Action.Read,
        resource: subject(ResourceType.Issues, {
            organizationId: ORG_ID,
            repoId: ASSIGNED_REPO_ID,
        }),
    },
    {
        label: 'update issues assigned repo',
        action: Action.Update,
        resource: subject(ResourceType.Issues, {
            organizationId: ORG_ID,
            repoId: ASSIGNED_REPO_ID,
        }),
    },
    {
        label: 'delete issues assigned repo',
        action: Action.Delete,
        resource: subject(ResourceType.Issues, {
            organizationId: ORG_ID,
            repoId: ASSIGNED_REPO_ID,
        }),
    },
    {
        label: 'read cockpit org',
        action: Action.Read,
        resource: subject(ResourceType.Cockpit, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'read cockpit assigned repo',
        action: Action.Read,
        resource: subject(ResourceType.Cockpit, {
            organizationId: ORG_ID,
            repoId: ASSIGNED_REPO_ID,
        }),
    },
    {
        label: 'update cockpit org',
        action: Action.Update,
        resource: subject(ResourceType.Cockpit, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'read git settings',
        action: Action.Read,
        resource: subject(ResourceType.GitSettings, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'update git settings',
        action: Action.Update,
        resource: subject(ResourceType.GitSettings, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'read plugin settings',
        action: Action.Read,
        resource: subject(ResourceType.PluginSettings, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'update plugin settings',
        action: Action.Update,
        resource: subject(ResourceType.PluginSettings, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'read logs global',
        action: Action.Read,
        resource: subject(ResourceType.Logs, {
            organizationId: ORG_ID,
            repoId: 'global',
        }),
    },
    {
        label: 'read pull requests assigned repo',
        action: Action.Read,
        resource: subject(ResourceType.PullRequests, {
            organizationId: ORG_ID,
            repoId: ASSIGNED_REPO_ID,
        }),
    },
    {
        label: 'read user settings',
        action: Action.Read,
        resource: subject(ResourceType.UserSettings, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'read issues settings',
        action: Action.Read,
        resource: subject(ResourceType.IssuesSettings, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'update issues settings',
        action: Action.Update,
        resource: subject(ResourceType.IssuesSettings, {
            organizationId: ORG_ID,
        }),
    },
    {
        label: 'read unassigned repo code review settings',
        action: Action.Read,
        resource: subject(ResourceType.CodeReviewSettings, {
            organizationId: ORG_ID,
            repoId: OTHER_REPO_ID,
        }),
    },
];

describe('PermissionsAbilityFactory', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        permissionsServiceMock.findOne.mockResolvedValue({
            permissions: {
                assignedRepositoryIds: [ASSIGNED_REPO_ID],
            },
        });
    });

    it.each([
        Role.OWNER,
        Role.REPO_ADMIN,
        Role.BILLING_MANAGER,
        Role.CONTRIBUTOR,
    ])(
        'keeps the same ability matrix for %s in cloud and licensed self-hosted',
        async (role) => {
            const cloudFactory = new PermissionsAbilityFactory(
                permissionsServiceMock as IPermissionsService,
                createLicenseServiceMock(
                    SubscriptionStatus.ACTIVE,
                ) as ILicenseService,
            );
            const enterpriseFactory = new PermissionsAbilityFactory(
                permissionsServiceMock as IPermissionsService,
                createLicenseServiceMock(
                    SubscriptionStatus.LICENSED_SELF_HOSTED,
                ) as ILicenseService,
            );

            const cloudAbility = await cloudFactory.createForUser(
                createUser(role),
            );
            const enterpriseAbility = await enterpriseFactory.createForUser(
                createUser(role),
            );

            for (const check of abilityChecks) {
                expect(
                    enterpriseAbility.can(check.action, check.resource as any),
                ).toBe(cloudAbility.can(check.action, check.resource as any));
            }
        },
    );
});
