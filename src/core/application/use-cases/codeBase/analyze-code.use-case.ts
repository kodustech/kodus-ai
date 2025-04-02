import { Inject, Injectable } from '@nestjs/common';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { REQUEST } from '@nestjs/core';


import * as path from 'path';
import { CodeKnowledgeGraphService } from '@/ee/codeBase/ast/services/code-knowledge-graph.service';
import { CodeAnalyzerService } from '@/ee/codeBase/ast/services/code-analyzer.service';
import { DiffAnalyzerService } from '@/ee/codeBase/diffAnalyzer.service';

export interface AnalysisResult {
    dependentFiles: string[];
    impactAnalysis: {
        files: string[];
        functions: {
            name: string;
            usedIn: string[];
        }[];
        types: {
            name: string;
            usedIn: {
                files: string[];
                functions: string[];
                types: string[];
            };
        }[];
    };
    functionsAffected?: {
        added: string[];
        modified: string[];
        deleted: string[];
    };
}

@Injectable()
export class AnalyzeCodeChangesUseCase {
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
        private readonly codeService: CodeManagementService,
        private readonly codeKnowledgeGraphService: CodeKnowledgeGraphService,
        private readonly codeAnalyzerService: CodeAnalyzerService,
        private readonly diffAnalyzerService: DiffAnalyzerService,
    ) { }

    async execute(codeChunk: string, fileName: string): Promise<any> {
        try {
            console.time('Total execution time');

            console.time('Clone repositories');
            await this.codeService.cloneRepository({
                repository: {
                    defaultBranch: 'feat-better-integration-error-treatment', //TODO: pegar do branch origem do PR
                    name: '',
                    fullName: `org/${'repoName'}`,
                    id: '', // TODO: Pegar por parametro
                },
                organizationAndTeamData: {
                    organizationId: this.request.user.organization.uuid,
                },
            });

            await this.codeService.cloneRepository({
                repository: {
                    defaultBranch: 'fix/ignore-paths-global', //TODO: pegar do branch destino do PR
                    name: '',
                    fullName: `org/${'repoName'}`,
                    id: '', // TODO: Pegar por parametro
                },
                organizationAndTeamData: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
            console.timeEnd('Clone repositories');

            const basePullRequestDir = `/usr/src/app/temp/${this.request.user.organization.uuid}/repositories/${'repoId'}:${'repoName'}/feat-better-integration-error-treatment`;
            const baseBaseDir = `/usr/src/app/temp/${this.request.user.organization.uuid}/repositories/${'repoId'}:${'repoName'}/d42f47f4af43dae7b7b51f0610b3b2c3`; // tem que pegar do retorno do clone (esse id do branch é gerado no sanitizer do clone)

            console.time('Preprocess diff');
            const processedChunk =
                this.codeAnalyzerService.preprocessCustomDiff(codeChunk);
            console.timeEnd('Preprocess diff');

            // console.time('Build graphs');
            // const pullRequestCodeGraph: CodeGraph =
            //     await this.codeKnowledgeGraphService.buildGraph(
            //         basePullRequestDir,
            //     );

            // const baseCodeGraph: CodeGraph =
            //     await this.codeKnowledgeGraphService.buildGraph(baseBaseDir);
            // console.timeEnd('Build graphs');

            // console.time('Enrich graph');
            // const baseCodeGraphEnriched: EnrichGraph =
            //     await this.codeAnalyzerService.enrichGraph(baseCodeGraph);
            // console.timeEnd('Enrich graph');

            const prFilePath = path.join(basePullRequestDir, fileName);
            const baseFilePath = path.join(baseBaseDir, fileName);

            console.timeEnd('Find dependent files');

            // console.time('Analyze diff');
            // const functionsAffected =
            //     await this.diffAnalyzerService.analyzeDiff(
            //         {
            //             diff: processedChunk,
            //             headCodeGraphFunctions: pullRequestCodeGraph.functions,
            //             prFilePath,
            //         },
            //         {
            //             baseCodeGraphFunctions: pullRequestCodeGraph.functions,
            //             baseFilePath,
            //         },
            //     );
            console.timeEnd('Analyze diff');

            console.time('DFS analysis');

            // const impactedNodes =
            //     this.codeAnalyzerService.computeImpactAnalysis(
            //         baseCodeGraphEnriched,
            //         [functionsAffected],
            //         1,
            //         'backward',
            //     );

            console.timeEnd('DFS analysis');

            console.time('Check function similarity');

            // const similarFunctions =
            //     await this.codeAnalyzerService.checkFunctionSimilarity(
            //         {
            //             organizationAndTeamData: {
            //                 organizationId: this.request.user.organization.uuid,
            //             },
            //             pullRequest: {},
            //         },
            //         functionsAffected.added,
            //         Object.values(baseCodeGraph.functions),
            //     );

            // console.timeEnd('Check function similarity');

            // console.timeEnd('Total execution time');

            return {
                // impactedNodes,
                // similarFunctions,
            };
        } catch (error) {
            console.error('❌ Erro na análise:', error);
            throw error;
        }
    }
}
