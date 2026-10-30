import { IssuesService } from './issues.service';

/**
 * An issue must not be lost because its repository has no language.
 *
 * `language` is `required: true` on the Mongoose schema, and Mongoose counts an
 * EMPTY STRING as absent — so a provider that reports no language (Bitbucket
 * returns `language: ""`) makes every issue from that repository fail
 * validation. Production, two hours: 17 rejections across 6 organizations, each
 * one an issue the customer never received and no screen ever mentioned.
 *
 * The rule lives on the write boundary rather than the call sites because that
 * is what the incident showed: of the paths that build an issue, exactly one
 * defended itself and the rest did not.
 */
const capture = () => {
    const created: Array<Record<string, unknown>> = [];
    const repo = {
        create: jest.fn(async (issue: Record<string, unknown>) => {
            created.push(issue);
            return issue as never;
        }),
    };
    return { repo, created, service: new IssuesService(repo as never) };
};

const issue = (language: unknown) =>
    ({
        title: 't',
        description: 'd',
        filePath: 'src/a.ts',
        language,
        label: 'bug',
        severity: 'medium',
    }) as never;

describe('IssuesService.create — language never reaches the schema empty', () => {
    it.each([
        ['an empty string (what Bitbucket sends)', ''],
        ['whitespace only', '   '],
        ['undefined', undefined],
        ['null', null],
    ])('substitutes for %s', async (_label, value) => {
        const { service, created } = capture();

        await service.create(issue(value));

        expect(created[0].language).toBe('unknown');
    });

    it('keeps a real language untouched', async () => {
        const { service, created } = capture();

        await service.create(issue('typescript'));

        expect(created[0].language).toBe('typescript');
    });

    it('trims a padded language rather than storing the padding', async () => {
        const { service, created } = capture();

        await service.create(issue('  typescript  '));

        expect(created[0].language).toBe('typescript');
    });

    it('changes nothing else about the issue', async () => {
        // A normaliser that quietly reshapes the rest would be worse than the
        // bug it fixes.
        const { service, created } = capture();

        await service.create(issue(''));

        expect(created[0]).toMatchObject({
            title: 't',
            description: 'd',
            filePath: 'src/a.ts',
            label: 'bug',
            severity: 'medium',
        });
    });
});
