import 'reflect-metadata';
import { Test } from '@nestjs/testing';

import {
    ANALYZER_TOOLS_TOKEN,
    ANALYZER_TOOL_IDS,
    AnalyzerTool,
} from '@libs/code-review/infrastructure/analyzers/tool.contract';

import { CodeReviewPipelineModule } from './code-review-pipeline.module';

type FactoryProvider = {
    provide: symbol;
    useFactory: (...args: unknown[]) => AnalyzerTool[];
    inject: unknown[];
};

const registryProvider = (): FactoryProvider => {
    const providers = Reflect.getMetadata(
        'providers',
        CodeReviewPipelineModule,
    ) as unknown[];

    const entry = providers.find(
        (provider): provider is FactoryProvider =>
            typeof provider === 'object' &&
            provider !== null &&
            (provider as { provide?: symbol }).provide === ANALYZER_TOOLS_TOKEN,
    );

    if (!entry) {
        throw new Error('the analyzer registry provider is not registered');
    }
    return entry;
};

/**
 * The registry is assembled by a factory whose parameters are matched to
 * `inject` BY POSITION, and the stage in turn pairs tools to routing decisions
 * by position. Nothing about that is visible at compile time: adding a tool to
 * one list and not the other produces a registry that is silently wrong rather
 * than one that fails to build.
 */
describe('the analyzer tool registry', () => {
    const provider = registryProvider();

    it('injects exactly as many tools as the factory takes', () => {
        expect(provider.inject).toHaveLength(provider.useFactory.length);
    });

    describe('once resolved through DI', () => {
        let tools: AnalyzerTool[];

        beforeAll(async () => {
            const moduleRef = await Test.createTestingModule({
                providers: [...(provider.inject as never[]), provider as never],
            }).compile();

            tools = moduleRef.get<AnalyzerTool[]>(ANALYZER_TOOLS_TOKEN);
        });

        it('holds one tool per declared id', () => {
            expect([...tools.map((tool) => tool.id)].sort()).toEqual(
                [...ANALYZER_TOOL_IDS].sort(),
            );
        });

        // Two tools sharing an id makes per-tool configuration address the
        // wrong one, and makes a reported skip unattributable.
        it('gives every tool a distinct id', () => {
            const ids = tools.map((tool) => tool.id);
            expect(new Set(ids).size).toBe(ids.length);
        });

        it('gives every tool the full contract', () => {
            for (const tool of tools) {
                expect(typeof tool.selectFiles).toBe('function');
                expect(typeof tool.run).toBe('function');
            }
        });
    });
});
