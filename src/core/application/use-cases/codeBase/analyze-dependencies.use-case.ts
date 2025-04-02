import { Inject, Injectable } from '@nestjs/common';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { REQUEST } from '@nestjs/core';
import { CodeKnowledgeGraphService } from '@/ee/codeBase/ast/services/code-knowledge-graph.service';
import { CodeAnalyzerService } from '@/ee/codeBase/ast/services/code-analyzer.service';

@Injectable()
export class AnalyzeDependenciesUseCase {
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private readonly codeKnowledgeGraphService: CodeKnowledgeGraphService,
        private readonly codeService: CodeManagementService,
        private readonly codeAnalyzerService: CodeAnalyzerService,
    ) { }

    async execute(entryFile: string, baseDir: string): Promise<any> {
        try {
            const repoDir = 'baseDir';
            // const repoDir = await this.codeService.cloneRepository({
            //     repository: {

            //     },
            //     organizationAndTeamData: {
            //         organizationId: this.request.user.organization.uuid,
            //     },
            // });

            if (!repoDir || repoDir.trim() === '') {
                throw new Error(
                    'Repository directory not found or invalid',
                );
            }

            const progressCallback = (processed: number, total: number) => {
                const percentage = Math.round((processed / total) * 100);
            };

            const codeGraph =
                await this.codeKnowledgeGraphService.buildGraphProgressively(
                    repoDir,
                    progressCallback,
                );

            const enrichGraph =
                await this.codeAnalyzerService.enrichGraph(codeGraph);

            return {
                codeGraph:
                    this.codeKnowledgeGraphService.prepareGraphForSerialization(
                        codeGraph,
                    ),
                enrichGraph,
            };
        } catch (error) {
            throw error;
        }
    }
}
