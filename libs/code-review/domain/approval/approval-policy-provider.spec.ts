import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { approvalPolicyProviderError } from './approval-policy-provider';

const policy = { id: 'team', name: 'Team', enabled: false };
it.each([PlatformType.GITHUB, PlatformType.GITLAB, PlatformType.AZURE_REPOS])(
    'accepts native teams on %s',
    (provider) => {
        expect(
            approvalPolicyProviderError(
                [{ ...policy, authorTeams: ['backend'] }],
                provider,
            ),
        ).toBeUndefined();
    },
);
it.each([PlatformType.BITBUCKET, PlatformType.FORGEJO])(
    'rejects unsupported team selectors on %s, including disabled policies',
    (provider) => {
        expect(
            approvalPolicyProviderError(
                [{ ...policy, authorTeams: ['backend'] }],
                provider,
            ),
        ).toContain('team conditions are unavailable');
    },
);
it.each([PlatformType.BITBUCKET, PlatformType.AZURE_REPOS])(
    'rejects unsupported PR label selectors on %s',
    (provider) => {
        expect(
            approvalPolicyProviderError(
                [{ ...policy, labels: ['ready'] }],
                provider,
            ),
        ).toContain('label conditions are unavailable');
    },
);
it('allows usernames and file conditions on hosts without teams', () => {
    expect(
        approvalPolicyProviderError(
            [{ ...policy, authors: ['build-bot'], includedFiles: ['docs/**'] }],
            PlatformType.FORGEJO,
        ),
    ).toBeUndefined();
});
it('rejects provider-dependent selectors when the host cannot be verified', () => {
    expect(
        approvalPolicyProviderError(
            [{ ...policy, authorTeams: ['backend'] }],
            undefined,
        ),
    ).toContain('Connect a code provider');
});
