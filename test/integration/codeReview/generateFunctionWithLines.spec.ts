import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ILogService } from '@/core/domain/log/contracts/log.service.contracts';
import { CodeAnalyzerService } from '@/ee/codeBase/ast/services/code-analyzer.service';

describe('CodeAnalyzerService - generateFunctionWithLines', () => {
    let codeAnalyzerService: CodeAnalyzerService;
    let mockLogService: ILogService;
    let logger: PinoLoggerService;

    beforeEach(() => {
        mockLogService = {
            register: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            findById: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            getNativeCollection: jest.fn(),
        };

        logger = new PinoLoggerService(mockLogService);
        jest.spyOn(logger, 'log').mockImplementation(() => { });
        jest.spyOn(logger, 'error').mockImplementation(() => { });
        jest.spyOn(logger, 'warn').mockImplementation(() => { });
        jest.spyOn(logger, 'debug').mockImplementation(() => { });
        jest.spyOn(logger, 'verbose').mockImplementation(() => { });

        codeAnalyzerService = new CodeAnalyzerService(logger);
    });

    it('should return the correct function lines with complex identation', () => {
        const code = `async execute(codeChunk: string, fileName: string): Promise<any> {
        try {
            console.time('Total execution time');
            const repoId = '';
            const repoName = '';

            console.time('Clone repositories');
            await this.codeService.cloneRepository({
                repository: {
                    defaultBranch: 'feat-better-integration-error-treatment', //TODO: pegar do branch origem do PR
                    name: repoName,
                    fullName: \`org/${''}\`,
                    id: repoId, // TODO: Pegar por parametro
                },
                organizationAndTeamData: {
                    organizationId: this.request.user.organization.uuid,
                },
            });

            await this.codeService.cloneRepository({
                repository: {
                    defaultBranch: 'fix/ignore-paths-global', //TODO: pegar do branch destino do PR
                    name: repoName,
                    fullName: \`org/${''}\`,
                    id: repoId, // TODO: Pegar por parametro
                },
                organizationAndTeamData: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
            console.timeEnd('Clone repositories');

            const basePullRequestDir = \`/usr/src/app/temp/this.request.user.organization.uuid}/repositories/repoId:repoName/feat-better-integration-error-treatment\`;
            const baseBaseDir = \`/usr/src/app/temp/this.request.user.organization.uuid}/repositories/repoId:repoName/d42f47f4af43dae7b7b51f0610b3b2c3\`; // tem que pegar do retorno do clone (esse id do branch é gerado no sanitizer do clone)

            console.time('Preprocess diff');
            const processedChunk =
                this.codeAnalyzerService.preprocessCustomDiff(codeChunk);
            console.timeEnd('Preprocess diff');

            console.time('Build graphs');
            const pullRequestCodeGraph: CodeGraph =
                await this.codeKnowledgeGraphService.buildGraph(
                    basePullRequestDir,
                );

            const baseCodeGraph: CodeGraph =
                await this.codeKnowledgeGraphService.buildGraph(baseBaseDir);
            console.timeEnd('Build graphs');

            console.time('Enrich graph');
            const baseCodeGraphEnriched: EnrichGraph =
                await this.codeAnalyzerService.enrichGraph(baseCodeGraph);
            console.timeEnd('Enrich graph');

            const prFilePath = path.join(basePullRequestDir, fileName);
            const baseFilePath = path.join(baseBaseDir, fileName);

            console.timeEnd('Find dependent files');

            console.time('Analyze diff');
            const functionsAffected =
                await this.diffAnalyzerService.analyzeDiff(
                    {
                        diff: processedChunk,
                        pullRequestCodeGraph,
                        prFilePath,
                    },
                    {
                        baseCodeGraph,
                        baseFilePath,
                    },
                );
            console.timeEnd('Analyze diff');

            console.time('DFS analysis');

            const impactedNodes =
                this.codeAnalyzerService.computeImpactAnalysis(
                    baseCodeGraphEnriched,
                    [functionsAffected],
                    1,
                    'backward',
                );

            console.timeEnd('DFS analysis');

            console.time('Check function similarity');

            const similarFunctions =
                await this.codeAnalyzerService.checkFunctionSimilarity(
                    {
                        organizationAndTeamData: {
                            organizationId: this.request.user.organization.uuid,
                        },
                        pullRequest: {},
                    },
                    functionsAffected.added,
                    Object.values(baseCodeGraph.functions),
                );

            console.timeEnd('Check function similarity');

            console.timeEnd('Total execution time');

            return {
                impactedNodes,
                similarFunctions,
            };
        } catch (error) {
            console.error('❌ Erro na análise:', error);
            throw error;
        }
    }
}`;

        const result = codeAnalyzerService.generateFunctionWithLines(
            code,
            51,
            165,
        );

        const expected = code
            .split('\n')
            .map((line, index) => `${51 + index} ${line}`)
            .join('\n');

        expect(result).toBe(expected);
    });
    it('should generate function with correct line numbers for simple function', () => {
        const code = [
            'function simpleFunction() {',
            '    const x = 1;',
            '    return x;',
            '}',
        ].join('\n');

        const result = codeAnalyzerService.generateFunctionWithLines(
            code,
            10,
            13,
        );

        const expected = [
            '10 function simpleFunction() {',
            '11     const x = 1;',
            '12     return x;',
            '13 }',
        ].join('\n');

        expect(result).toBe(expected);
    });

    it('should handle empty lines correctly', () => {
        const code = `
function withEmptyLines() {

    const x = 1;

    return x;

}`.trim();

        const result = codeAnalyzerService.generateFunctionWithLines(
            code,
            20,
            26,
        );

        const expected = `20 function withEmptyLines() {
21
22     const x = 1;
23
24     return x;
25
26 }`;

        expect(result).toBe(expected);
    });

    it('should handle single line function', () => {
        const code = `const singleLine = () => console.log('test');`;

        const result = codeAnalyzerService.generateFunctionWithLines(
            code,
            5,
            5,
        );

        expect(result).toBe("5 const singleLine = () => console.log('test');");
    });

    it('should handle function with special characters and comments', () => {
        const code = `
// Special function
function special$Function() {
    // TODO: Implement
    const π = 3.14;
    return \`Value: \${π}\`;
}`.trim();

        const result = codeAnalyzerService.generateFunctionWithLines(
            code,
            50,
            55,
        );

        const expected = `50 // Special function
51 function special$Function() {
52     // TODO: Implement
53     const π = 3.14;
54     return \`Value: \${π}\`;
55 }`;

        expect(result).toBe(expected);
    });

    it('should handle function with decorators and metadata', () => {
        const code = `
@Injectable()
@Metadata({
    version: '1.0'
})
public async decoratedFunction(): Promise<void> {
    await this.init();
}`.trim();

        const result = codeAnalyzerService.generateFunctionWithLines(
            code,
            200,
            206,
        );

        const expected = `200 @Injectable()
201 @Metadata({
202     version: '1.0'
203 })
204 public async decoratedFunction(): Promise<void> {
205     await this.init();
206 }`;

        expect(result).toBe(expected);
    });
});
