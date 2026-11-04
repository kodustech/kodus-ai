import { FileReviewContextPreparation } from '@/ee/codeReview/fileReviewContextPreparation/file-review-context-preparation.service';

describe('FileReviewContextPreparation (EE)', () => {
    let service: FileReviewContextPreparation;

    beforeEach(() => {
        service = new FileReviewContextPreparation({} as any);
    });

    describe('getRelevantFileContent', () => {
        it('should return full file content and hasRelevantContent false when no graph content', async () => {
            const file = {
                filename: 'test.ts',
                fileContent: 'const a = 1;',
                content: 'const a = 1;',
            } as any;

            const context = {
                organizationAndTeamData: {
                    organizationId: 'org',
                    teamId: 'team',
                },
            } as any;

            // Accessing protected method for unit test
            const result = await (service as any).getRelevantFileContent(
                file,
                context,
            );

            expect(result.relevantContent).toBe('const a = 1;');
            expect(result.hasRelevantContent).toBe(false);
        });

        it('should fallback to file.content if fileContent is missing', async () => {
            const file = {
                filename: 'test.ts',
                content: 'const b = 2;',
            } as any;

            const context = {
                organizationAndTeamData: {},
            } as any;

            const result = await (service as any).getRelevantFileContent(
                file,
                context,
            );

            expect(result.relevantContent).toBe('const b = 2;');
            expect(result.hasRelevantContent).toBe(false);
        });
    });
});
