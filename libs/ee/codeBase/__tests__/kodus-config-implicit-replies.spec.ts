/**
 * #2576 QA M16 and M35. A non-boolean `conversation.implicitReplies` in
 * kodus-config.yml was counted as on by the reply gate, and the centralized
 * sync stored that value because it saves whatever this loader returns.
 * The key has to come back missing, so the stored boolean applies and the
 * string is never written. A real boolean is kept.
 *
 * The warning names the caller and the type of the value. The value itself
 * stays out of the log: repository YAML can put a secret in the field.
 */
import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
const repository = { id: 'repo-1', name: 'hive-inventory' };

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

function expectedWarn(valueType: string) {
    return {
        message:
            'Ignoring an invalid conversation.implicitReplies in kodus-config.yml: the stored setting applies',
        context: 'CodeBaseConfigService',
        metadata: {
            organizationAndTeamData,
            repository,
            valueType,
        },
    };
}

const load = (fileContent: string, onRejectedImplicitReplies?: () => void) => {
    const svc = service(fileContent);
    const file = svc.getKodusConfigFile({
        organizationAndTeamData,
        repository,
        defaultBranch: 'main',
        onRejectedImplicitReplies,
    });
    return { svc, file };
};

describe('kodus-config.yml conversation.implicitReplies', () => {
    it.each([
        [
            'a quoted false',
            'conversation:\n  implicitReplies: "false"\n',
            'string',
        ],
        ['YAML 1.2 no', 'conversation:\n  implicitReplies: no\n', 'string'],
        ['YAML 1.2 off', 'conversation:\n  implicitReplies: off\n', 'string'],
        ['a number', 'conversation:\n  implicitReplies: 0\n', 'number'],
        ['null', 'conversation:\n  implicitReplies: null\n', 'null'],
        ['an empty key', 'conversation:\n  implicitReplies:\n', 'null'],
    ])(
        'drops %s and keeps the rest of the file',
        async (_label, yaml, valueType) => {
            const onRejectedImplicitReplies = jest.fn();
            const { svc, file } = load(
                `automatedReviewActive: false\n${yaml}`,
                onRejectedImplicitReplies,
            );

            await expect(file).resolves.toEqual({
                automatedReviewActive: false,
                conversation: {},
            });
            expect(onRejectedImplicitReplies).toHaveBeenCalledTimes(1);
            expect(svc.logger.warn).toHaveBeenCalledTimes(1);
            expect(svc.logger.warn).toHaveBeenCalledWith(
                expectedWarn(valueType),
            );
        },
    );

    it('drops a conversation block that is not an object', async () => {
        const onRejectedImplicitReplies = jest.fn();
        const { svc, file } = load(
            'conversation: "false"\n',
            onRejectedImplicitReplies,
        );

        await expect(file).resolves.toEqual({});
        expect(onRejectedImplicitReplies).toHaveBeenCalledTimes(1);
        expect(svc.logger.warn).toHaveBeenCalledTimes(1);
        expect(svc.logger.warn).toHaveBeenCalledWith(expectedWarn('string'));
    });

    it.each([
        ['string', 'implicitReplies: "kodus-canary-secret-SHOULD-NOT-LOG"'],
        [
            'object',
            'implicitReplies:\n    token: kodus-canary-secret-SHOULD-NOT-LOG',
        ],
    ])('logs the %s type and not the value', async (valueType, field) => {
        const { svc, file } = load(
            `conversation:\n  ${field}\nautomatedReviewActive: false\n`,
        );

        await expect(file).resolves.toEqual({
            automatedReviewActive: false,
            conversation: {},
        });
        expect(JSON.stringify(svc.logger.warn.mock.calls)).not.toContain(
            'kodus-canary-secret-SHOULD-NOT-LOG',
        );
        expect(svc.logger.warn).toHaveBeenCalledTimes(1);
        expect(svc.logger.warn).toHaveBeenCalledWith(expectedWarn(valueType));
    });

    it.each([
        ['false', false],
        ['true', true],
    ])('keeps a boolean %s', async (literal, expected) => {
        const onRejectedImplicitReplies = jest.fn();
        const { svc, file } = load(
            `conversation:\n  implicitReplies: ${literal}\n`,
            onRejectedImplicitReplies,
        );

        await expect(file).resolves.toEqual({
            conversation: { implicitReplies: expected },
        });
        expect(onRejectedImplicitReplies).not.toHaveBeenCalled();
        expect(svc.logger.warn).not.toHaveBeenCalled();
    });
});
