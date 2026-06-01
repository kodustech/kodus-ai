import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RepositoryModel } from '../infrastructure/adapters/repositories/schemas/repository.model';
import { AstNodeModel } from '../infrastructure/adapters/repositories/schemas/astNode.model';
import { AstEdgeModel } from '../infrastructure/adapters/repositories/schemas/astEdge.model';

import { REPOSITORY_REPOSITORY_TOKEN } from '../domain/contracts/RepositoryRepository.contract';
import { REPOSITORY_SERVICE_TOKEN } from '../domain/contracts/RepositoryService.contract';
import { RepositoryRepository } from '../infrastructure/adapters/repositories/repository.repository';
import { AstGraphRepository } from '../infrastructure/adapters/repositories/astGraph.repository';
import { RepositoryService } from '../infrastructure/adapters/services/repository.service';
import { KodusGraphCli } from '../infrastructure/adapters/services/graph/kodus-graph-cli';
import { GraphIndexerService } from '../infrastructure/adapters/services/graph/graph-indexer.service';
import { GraphContextService } from '../infrastructure/adapters/services/graph/graph-context.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([RepositoryModel, AstNodeModel, AstEdgeModel]),
    ],
    providers: [
        {
            provide: REPOSITORY_REPOSITORY_TOKEN,
            useClass: RepositoryRepository,
        },
        AstGraphRepository,
        {
            provide: REPOSITORY_SERVICE_TOKEN,
            useClass: RepositoryService,
        },
        KodusGraphCli,
        GraphIndexerService,
        GraphContextService,
    ],
    exports: [
        AstGraphRepository,
        REPOSITORY_SERVICE_TOKEN,
        KodusGraphCli,
        GraphIndexerService,
        GraphContextService,
    ],
})
export class AstGraphModule {}
