import validateKodusConfigFile, {
    getDefaultKodusConfigFile,
} from '../validateCodeReviewConfigFile';

/**
 * `default-kodus-config.yml` is what a new organization starts from and what
 * the config page offers to download, so a key it ships that the schema
 * refuses comes back to the customer as a validation error the moment they
 * save the file. These cases pin the `conversation` block (#2576) to the
 * schema that checked it.
 *
 * The file has older drift of its own - keys it ships that `codereview.json`
 * does not declare yet - so these cases look at the errors that mention
 * `conversation` rather than at `isValidConfigFile`.
 */
describe('the conversation block of the shipped kodus-config.yml', () => {
    const defaults = getDefaultKodusConfigFile() as any;

    const messagesFor = (config: any): string[] =>
        (validateKodusConfigFile(config).validationErrors ?? []).map(
            (error: any) =>
                `${error.instancePath} ${
                    (error.params as any)?.additionalProperty ?? ''
                } ${error.message}`,
        );

    const shipping = (conversation: unknown) =>
        messagesFor({ ...defaults, version: '1.2', conversation });

    it('ships the setting, on by default', () => {
        expect(defaults.conversation).toEqual({ implicitReplies: true });
    });

    it('is accepted by the schema', () => {
        expect(
            shipping({ implicitReplies: true }).filter((message) =>
                message.includes('conversation'),
            ),
        ).toEqual([]);
    });

    it('accepts a repository that turns implicit replies off', () => {
        expect(
            shipping({ implicitReplies: false }).filter((message) =>
                message.includes('conversation'),
            ),
        ).toEqual([]);
    });

    it('refuses a value that is not a boolean', () => {
        expect(
            shipping({ implicitReplies: 'off' }).some((message) =>
                message.includes('implicitReplies'),
            ),
        ).toBe(true);
    });

    it('refuses a key it does not know', () => {
        expect(
            shipping({ implicitReplies: true, answerEveryone: true }).some(
                (message) =>
                    message.includes('answerEveryone') ||
                    message.includes('additionalProperty'),
            ),
        ).toBe(true);
    });
});
