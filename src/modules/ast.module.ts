
import { forwardRef, Module } from '@nestjs/common';
import { CodebaseModule } from './codeBase.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { LogModule } from './log.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { CodeAnalyzerService } from '@/ee/codeBase/ast/services/code-analyzer.service';
import { TreeSitterService } from '@/ee/codeBase/ast/services/tree-sitter.service';
import { ImportPathResolverService } from '@/ee/codeBase/ast/services/import-path-resolver.service';
import { ResolverFactory } from '@/ee/codeBase/ast/resolvers/ResolverFactory';
import { CodeQualityAnalyzerService } from '@/ee/codeBase/ast/services/code-quality-analyzer.service';
import { CodeKnowledgeGraphService } from '@/ee/codeBase/ast/services/code-knowledge-graph.service';
import { TypeScriptParser } from '@/ee/codeBase/ast/parsers/TypeScriptParser';


const services = [
    TreeSitterService,
    CodeKnowledgeGraphService,
    CodeQualityAnalyzerService,
    TypeScriptParser,
    CodeAnalyzerService,
    ImportPathResolverService,
    ResolverFactory,
];

const providers = [
    ...services,
    {
        provide: 'IImportPathResolver',
        useClass: ImportPathResolverService,
    },
];

const moduleExports = [...services, 'IImportPathResolver'];

@Module({
    imports: [
        forwardRef(() => CodebaseModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        LogModule,
    ],
    providers,
    exports: moduleExports,
})
export class AstModule { }
