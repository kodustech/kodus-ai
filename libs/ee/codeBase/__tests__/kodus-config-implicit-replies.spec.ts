/**
 * #2576 QA M16 and M35. A non-boolean `conversation.implicitReplies` in
 * kodus-config.yml was counted as on by the reply gate, and the centralized
 * sync stored that value because it saves whatever this loader returns.
 * The key has to come back missing, so the stored boolean applies and the
 * string is never written. A real boolean is kept.
 */
import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';

function service(fileContent: string) {
    const svc = Object.create(CodeBaseConfigService.prototype) as any;
    svc.logger = { warn: jest.fn() };
    // `conversation` has to be a known key. Otherwise the unknown-key strip
    // removes it before the boolean check, and this test would pass on the
    // pre-fix loader.
    svc.DEFAULT_CONFIG = {
        automatedReviewActive: true,
        conversation: { implicitReplies: true },
    };
    svc.codeManagementService = {
        getTypeIntegration: jest.fn(async () => 'github'),
        getRepositoryContentFile: jest.fn(async () => ({
            data: { content: fileContent },
        })),
    };
    return svc as CodeBaseConfigService & { logger: { warn: jest.Mock } };
}

const load = (fileContent: string) =>
    service(fileContent).getKodusConfigFile({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'hive-inventory' },
        defaultBranch: 'main',
    });

describe('kodus-config.yml conversation.implicitReplies', () => {
    it.each([
        ['a quoted false', 'conversation:\n  implicitReplies: "false"\n'],
        ['YAML 1.2 no', 'conversation:\n  implicitReplies: no\n'],
        ['YAML 1.2 off', 'conversation:\n  implicitReplies: off\n'],
        ['a number', 'conversation:\n  implicitReplies: 0\n'],
        ['null', 'conversation:\n  implicitReplies: null\n'],
        ['an empty key', 'conversation:\n  implicitReplies:\n'],
    ])('drops %s and keeps the rest of the file', async (_label, yaml) => {
        const svc = service(`automatedReviewActive: false\n${yaml}`);
        const file = await svc.getKodusConfigFile({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { id: 'repo-1', name: 'hive-inventory' },
            defaultBranch: 'main',
        });

        expect(file?.conversation?.implicitReplies).toBeUndefined();
        expect(file?.automatedReviewActive).toBe(false);
        expect(svc.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining(
                    'invalid conversation.implicitReplies',
                ),
            }),
        );
    });

    it('drops a conversation block that is not an object', async () => {
        const file = await load('conversation: "false"\n');

        expect(file?.conversation).toBeUndefined();
    });

    it.each([
        ['false', false],
        ['true', true],
    ])('keeps a boolean %s', async (literal, expected) => {
        const file = await load(
            `conversation:\n  implicitReplies: ${literal}\n`,
        );

        expect(file?.conversation?.implicitReplies).toBe(expected);
    });
});
