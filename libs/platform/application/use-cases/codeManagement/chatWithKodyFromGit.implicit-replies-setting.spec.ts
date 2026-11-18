jest.mock('@libs/common/utils/thread-id', () => ({
    createThreadId: jest.fn(() => ({ id: 'TR-test', metadata: {} })),
}));

jest.mock('./implicit-reply', () => ({
    ...jest.requireActual('./implicit-reply'),
    classifyReplyAddressedToKody: jest.fn(),
}));

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { ChatWithKodyFromGitUseCase } from './chatWithKodyFromGit.use-case';
import { classifyReplyAddressedToKody } from './implicit-reply';

const classify = classifyReplyAddressedToKody as jest.Mock;

// buildPrKey rejects a non-UUID organization id.
const ORG = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const MARKER = '<!-- kody-codereview -->';
const ANSWER_MARKER = `${MARKER}\n<!-- kody-conversation -->`;

function setup(config: unknown) {
    const codeManagementService = {
        findTeamAndOrganizationIdByConfigKey: jest.fn().mockResolvedValue({
            integration: { organization: { uuid: ORG } },
            team: { uuid: TEAM },
        }),
        getPullRequestReviewComment: jest.fn(),
        addReactionToComment: jest.fn().mockResolvedValue(undefined),
        removeReactionsFromComment: jest.fn().mockResolvedValue(undefined),
        createResponseToComment: jest.fn().mockResolvedValue({ id: 999 }),
        updateResponseToComment: jest.fn().mockResolvedValue({}),
        getCloneParams: jest.fn().mockResolvedValue(undefined),
    };
    const conversationAgentUseCase = {
        execute: jest.fn().mockResolvedValue('an answer'),
    };
    const permissionValidationService = {
        validateExecutionPermissions: jest
            .fn()
            .mockResolvedValue({ allowed: true }),
        resolveTaskSlot: jest.fn().mockResolvedValue(undefined),
    };
    // The config cascade: `getSimpleConfig` resolves the deltas stored on the
    // config row, and `getKodusConfigFile` carries the repository's own
    // kodus-config.yml layer, which wins over them.
    const codeBaseConfigService =
        config === undefined
            ? undefined
            : {
                  getSimpleConfig: jest.fn().mockImplementation(async () => {
                      if (config instanceof Error) throw config;
                      return config;
                  }),
                  getKodusConfigFile: jest.fn().mockResolvedValue(undefined),
              };

    const useCase = new ChatWithKodyFromGitUseCase(
        codeManagementService as any,
        conversationAgentUseCase as any,
        { execute: jest.fn() } as any,
        permissionValidationService as any,
        {
            acquire: jest.fn().mockResolvedValue({
                sandbox: { type: 'null' },
                leaseId: 'lease',
            }),
            release: jest.fn().mockResolvedValue(undefined),
        } as any,
        {
            findByNumberAndRepositoryId: jest.fn().mockResolvedValue(null),
        } as any,
        undefined,
        undefined,
        undefined,
        undefined,
        codeBaseConfigService as any,
    );

    return {
        useCase,
        codeManagementService,
        conversationAgentUseCase,
        codeBaseConfigService,
    };
}

const at = (minute: number) =>
    `2026-09-24T10:${String(minute).padStart(2, '0')}:00Z`;

const kodyRoot = {
    id: 555,
    body: `This query can return duplicate rows. ${MARKER}`,
    user: { login: 'kodus-ai[bot]', type: 'Bot' },
    created_at: at(0),
};

const agentReply = {
    id: 900,
    in_reply_to_id: 555,
    body: 'Fixed in abc123.',
    user: { login: 'dev-one', type: 'User' },
    created_at: at(1),
};

function params(comment: { id: number; body: string }) {
    return {
        event: 'pull_request_review_comment',
        platformType: PlatformType.GITHUB,
        payload: {
            action: 'created',
            repository: { id: 'repo-1', name: 'billing-api' },
            pull_request: {
                number: 812,
                head: { ref: 'feat/x' },
                base: { ref: 'main' },
            },
            comment: { ...comment, in_reply_to_id: 555 },
            sender: { id: 'user-1', login: 'dev-one' },
        },
    } as any;
}

describe('ChatWithKodyFromGitUseCase — conversation.implicitReplies (#2576)', () => {
    beforeEach(() => {
        classify.mockReset();
        classify.mockResolvedValue(true);
    });

    it('stays quiet without running the classifier when the repository turned it off', async () => {
        // The case the issue is about: an agent replies "Fixed in abc123." to
        // every finding, under the developer's own account.
        const { useCase, codeManagementService, conversationAgentUseCase } =
            setup({ conversation: { implicitReplies: false } });
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        expect(classify).not.toHaveBeenCalled();
        expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
        expect(
            codeManagementService.createResponseToComment,
        ).not.toHaveBeenCalled();
    });

    it('answers an explicit @kody mention even with the setting off', async () => {
        const { useCase, codeManagementService, conversationAgentUseCase } =
            setup({ conversation: { implicitReplies: false } });
        const mention = { ...agentReply, body: '@kody why is this a problem?' };
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            mention,
        ]);

        await useCase.execute(params(mention));

        expect(classify).not.toHaveBeenCalled();
        expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(1);
        expect(
            codeManagementService.createResponseToComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                inReplyToId: 900,
                body: `an answer\n\n${ANSWER_MARKER}`,
            }),
        );
    });

    it.each([
        ['the setting is on', { conversation: { implicitReplies: true } }],
        ['the config says nothing', { reviewOptions: { bug: true } }],
    ])('keeps the classifier deciding when %s', async (_label, config) => {
        const { useCase, codeManagementService, conversationAgentUseCase } =
            setup(config);
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        expect(classify).toHaveBeenCalledTimes(1);
        expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it("keeps today's behaviour when the config cannot be read", async () => {
        const { useCase, codeManagementService, conversationAgentUseCase } =
            setup(new Error('config unavailable'));
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        expect(classify).toHaveBeenCalledTimes(1);
        expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it("reads the setting for the PR's repository", async () => {
        const { useCase, codeManagementService, codeBaseConfigService } = setup(
            {
                conversation: { implicitReplies: true },
            },
        );
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        expect(codeBaseConfigService.getSimpleConfig).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: ORG, teamId: TEAM }),
            expect.objectContaining({ repositoryId: 'repo-1' }),
        );
    });

    it('lets the repository kodus-config.yml turn replies off', async () => {
        const {
            useCase,
            codeManagementService,
            codeBaseConfigService,
            conversationAgentUseCase,
        } = setup({
            conversation: { implicitReplies: true },
            kodusConfigFileOverridesWebPreferences: true,
        });
        codeBaseConfigService.getKodusConfigFile.mockResolvedValue({
            conversation: { implicitReplies: false },
        });
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        expect(codeBaseConfigService.getKodusConfigFile).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.anything(),
                overrideConfig: true,
            }),
        );
        expect(classify).not.toHaveBeenCalled();
        expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
    });

    it('lets the repository kodus-config.yml turn replies back on', async () => {
        // The file is the later layer of the cascade: it wins over the
        // organization's stored opt-out, as it does for the review pipeline.
        const { useCase, codeManagementService, codeBaseConfigService } = setup(
            {
                conversation: { implicitReplies: false },
                kodusConfigFileOverridesWebPreferences: true,
            },
        );
        codeBaseConfigService.getKodusConfigFile.mockResolvedValue({
            conversation: { implicitReplies: true },
        });
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        expect(classify).toHaveBeenCalledTimes(1);
    });

    it('keeps the stored decision when the repository file cannot be read', async () => {
        const { useCase, codeManagementService, codeBaseConfigService } = setup(
            {
                conversation: { implicitReplies: false },
                kodusConfigFileOverridesWebPreferences: true,
            },
        );
        codeBaseConfigService.getKodusConfigFile.mockRejectedValue(
            new Error('file unavailable'),
        );
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        // The old code never read the file: this call is what the case pins.
        expect(codeBaseConfigService.getKodusConfigFile).toHaveBeenCalled();
        expect(classify).not.toHaveBeenCalled();
    });

    it('asks the loader not to apply the file when the repository never opted in', async () => {
        // `kodusConfigFileOverridesWebPreferences` defaults to false: the
        // loader returns nothing in that case, so a committed file cannot
        // reverse a stored decision on its own.
        const { useCase, codeManagementService, codeBaseConfigService } = setup(
            { conversation: { implicitReplies: false } },
        );
        codeBaseConfigService.getKodusConfigFile.mockResolvedValue(undefined);
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        expect(codeBaseConfigService.getKodusConfigFile).toHaveBeenCalledWith(
            expect.objectContaining({ overrideConfig: false }),
        );
        expect(classify).not.toHaveBeenCalled();
    });

    it('changes nothing for a wiring without the config service', async () => {
        const { useCase, codeManagementService, conversationAgentUseCase } =
            setup(undefined);
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            kodyRoot,
            agentReply,
        ]);

        await useCase.execute(params(agentReply));

        expect(classify).toHaveBeenCalledTimes(1);
        expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(1);
    });
});
