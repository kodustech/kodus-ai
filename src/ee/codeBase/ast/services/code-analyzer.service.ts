import { Injectable } from '@nestjs/common';
import { CodeGraph, FunctionAnalysis } from '../contracts/CodeGraph';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import {
    getChatGPT,
    getDeepseekByNovitaAI,
} from '@/shared/utils/langchainCommon/document';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { RunnableSequence } from '@langchain/core/runnables';
import { prompt_checkSimilarFunctions_system } from '@/shared/utils/langchainCommon/prompts/checkSimilarFunctions';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { SyntaxNode } from 'tree-sitter';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ChangeResult, FunctionResult } from '../../diffAnalyzer.service';

export enum NodeType {
    CLASS = 'CLASS',
    METHOD = 'METHOD',
    FUNCTION = 'FUNCTION',
    INTERFACE = 'INTERFACE',
}

interface FunctionData {
    className?: string;
    name?: string;
    calls?: { function: string; file: string }[];
    file: string;
}

interface EnrichGraphNode {
    id: string;
    type: NodeType;
    file: string;
    filePath: string;
}

export enum RelationshipType {
    CALLS = 'CALLS',
    CALLS_IMPLEMENTATION = 'CALLS_IMPLEMENTATION',
    HAS_METHOD = 'HAS_METHOD',
    IMPORTS = 'IMPORTS',
    IMPLEMENTS = 'IMPLEMENTS',
    IMPLEMENTED_BY = 'IMPLEMENTED_BY',
    EXTENDS = 'EXTENDS',
}

interface ImpactedNode {
    id: string;
    type: string;
    severity: string;
    level: number;
    filePath: string;
    calledBy?: string[];
    importedBy?: string[];
}

interface EnrichGraphEdge {
    from: string;
    to: string;
    type: RelationshipType;
    fromPath: string;
    toPath: string;
}

export interface EnrichGraph {
    nodes: EnrichGraphNode[];
    relationships: EnrichGraphEdge[];
}

export interface ScopeAnalysis {
    variables: string[];
    functions: string[];
    dependencies: string[];
}

export interface ComplexityAnalysis {
    cyclomaticComplexity: number;
    cognitiveComplexity: number;
    details: {
        conditionals: number;
        loops: number;
        switches: number;
        catches: number;
        logicalOperators: number;
        recursion: boolean;
    };
}

export interface ImpactResult {
    function: string;
    impact: {
        summary: any;
        groupedByLevel: Record<string, ImpactedNode[]>;
    };
}

export interface FunctionsAffect {
    functionName: string;
    filePath: string;
    functionBody: string;
}

export interface FunctionsAffectResult {
    oldFunction: string;
    newFunction: string;
    functionsAffect: FunctionsAffect[];
}

export interface FunctionSimilarity {
    functionName: string;
    similarFunctions: [];
}

@Injectable()
export class CodeAnalyzerService {
    private normalizedPathCache = new Map<string, string>();
    private extractPathCache = new Map<
        string,
        { filePath: string; identifier?: string }
    >();
    private addedNodes: Record<string, boolean> = {};
    private relationshipKeys: Record<string, boolean> = {};
    private nodes: EnrichGraphNode[] = [];
    private relationships = new Map<string, EnrichGraphEdge>();

    constructor(private readonly logger: PinoLoggerService) {}

    async checkFunctionSimilarity(
        context: {
            organizationAndTeamData: OrganizationAndTeamData;
            pullRequest: any;
        },
        addedFunctions: FunctionResult[],
        existingFunctions: FunctionAnalysis[],
    ): Promise<FunctionSimilarity[]> {
        const functionsResult: FunctionSimilarity[] = [];

        for (const addedFunction of addedFunctions) {
            const candidateSimilarFunctions: any[] = [];

            for (const key in existingFunctions) {
                const existingFunction = existingFunctions[key];

                if (
                    this.checkSignatureFunctionSimilarity(
                        addedFunction,
                        existingFunction,
                    )
                ) {
                    const { isSimilar } = this.checkBodyFunctionSimilarity(
                        addedFunction,
                        existingFunction,
                    );

                    if (isSimilar) {
                        candidateSimilarFunctions.push(existingFunction);
                    }
                }
            }

            functionsResult.push({
                functionName: addedFunction.fullName,
                similarFunctions: await this.checkFunctionSimilarityWithLLM(
                    context,
                    addedFunction,
                    candidateSimilarFunctions,
                ),
            });
        }

        return functionsResult;
    }

    private checkSignatureFunctionSimilarity(
        addedFunction: FunctionResult,
        existingFunction: FunctionAnalysis,
    ): boolean {
        return addedFunction.signatureHash === existingFunction.signatureHash;
    }

    private checkBodyFunctionSimilarity(
        addedFunction: FunctionResult,
        existingFunction: FunctionAnalysis,
        jaccardThreshold: number = 0.5,
    ): { jaccardScore: number; isSimilar: boolean } {
        const jaccardScore = this.jaccardSimilarity(
            addedFunction.functionHash,
            existingFunction.functionHash,
        );

        return { jaccardScore, isSimilar: jaccardScore >= jaccardThreshold };
    }

    private async checkFunctionSimilarityWithLLM(
        context: {
            organizationAndTeamData: OrganizationAndTeamData;
            pullRequest: any;
        },
        addedFunction: FunctionResult,
        existingFunctions: FunctionAnalysis[],
    ) {
        const functions = {
            addedFunction: {
                name: addedFunction.name,
                lines: addedFunction.lines,
                fullText: addedFunction.fullText,
            },
            existingFunctions: existingFunctions.map((func) => ({
                name: func.name,
                lines: func.lines,
                fullText: func.fullText,
            })),
        };

        const chain = await this.createChainWithFallback({
            ...context,
            functions,
        });

        const result = await chain.invoke({});

        return result;
    }

    // ----------------- Métodos Auxiliares -----------------

    preprocessCustomDiff(diff: string): string {
        return diff
            .split(/\r?\n/)
            .map((line) => {
                const trimmed = line.trim();
                if (!trimmed) return '';
                if (trimmed === '__new hunk__' || trimmed === '__old hunk__')
                    return '';
                const match = trimmed.match(/^(\d+)\s+([\+\- ])(.*)/);
                if (match) {
                    const sign = match[2];
                    const remainder = match[3];
                    return sign + remainder;
                }
                return trimmed;
            })
            .join('\n');
    }

    /**
     * Realiza uma busca em profundidade (DFS) em um grafo de dependências.
     * Suporta travessia nos sentidos direto, reverso ou bidirecional com filtragem por tipos de relacionamento.
     *
     * @param graph - O grafo de dependências contendo nós e relacionamentos.
     * @param startNodeId - O ID do nó inicial (por exemplo, "IntegrationService.getPlatformIntegration").
     * @param direction - Define a direção da travessia:
     *                    - "forward": Encontrar dependências (de quem esta função depende).
     *                    - "backward": Encontrar dependentes (quem depende desta função).
     *                    - "both": Traversar em ambas as direções.
     * @param allowedTypes - Tipos de relacionamento a serem seguidos (padrão para **todos** os tipos disponíveis no grafo).
     * @returns Um array de nós impactados.
     */
    dfs(
        graph: EnrichGraph,
        startNodeId: string,
        direction: 'both' | 'forward' | 'backward' = 'both',
        allowedTypes: RelationshipType[] = Array.from(
            new Set(graph.relationships.map((rel: any) => rel.type)),
        ),
    ): string[] {
        const visited = new Set<string>();
        this.dfsHelper(graph, startNodeId, visited, direction, allowedTypes);
        return Array.from(visited); // Converte Set para Array antes de retornar
    }

    /**
     * Recursive DFS helper function.
     */
    private dfsHelper(
        graph: EnrichGraph,
        currentNode: string,
        visited: Set<string>,
        direction: 'both' | 'forward' | 'backward',
        allowedTypes: RelationshipType[],
    ) {
        if (visited.has(currentNode)) return; // Evita loops infinitos
        visited.add(currentNode);

        for (const edge of graph.relationships) {
            const nextNode = this.getNextNode(
                edge,
                currentNode,
                direction,
                visited,
                allowedTypes,
            );
            if (nextNode) {
                this.dfsHelper(
                    graph,
                    nextNode,
                    visited,
                    direction,
                    allowedTypes,
                );
            }
        }
    }

    /**
     * Determines the next node to visit based on traversal direction and allowed relationships.
     */
    private getNextNode(
        edge: { from: string; to: string; type: RelationshipType },
        currentNode: string,
        direction: 'both' | 'forward' | 'backward',
        visited: Set<string>,
        allowedTypes: RelationshipType[],
    ): string | null {
        const isForward =
            direction !== 'backward' &&
            edge.from === currentNode &&
            !visited.has(edge.to);
        const isBackward =
            direction !== 'forward' &&
            edge.to === currentNode &&
            !visited.has(edge.from);

        if ((isForward || isBackward) && allowedTypes.includes(edge.type)) {
            return isForward ? edge.to : edge.from;
        }

        return null;
    }

    enrichGraph(data: CodeGraph): EnrichGraph {
        this.clearNormalizedPathCache();
        this.clearExtractPathCache();

        this.nodes = [];
        this.relationships.clear();
        this.addedNodes = {};
        this.relationshipKeys = {};

        console.log('🔄 Processando classes e interfaces...');
        console.log('🔄 enrichGraph - Tipos disponíveis:', data.types.size);
        console.log(
            '🔄 enrichGraph - Funções disponíveis:',
            data.functions.size,
        );
        console.log('🔄 enrichGraph - Arquivos disponíveis:', data.files.size);

        // Verificar estrutura de uma chave de tipo para debug
        if (data.types.size > 0) {
            const sampleTypeEntry = Array.from(data.types.entries())[0];
            console.log('🔄 Exemplo de chave de tipo:', sampleTypeEntry[0]);
            console.log('🔄 Valor do tipo:', sampleTypeEntry[1]);
        }

        // Converter Maps para objetos para compatibilidade com os métodos existentes
        const dataAsObjects = {
            types: Object.fromEntries(data.types),
            functions: Object.fromEntries(data.functions),
            files: Object.fromEntries(data.files),
        };

        this.processTypes(dataAsObjects);
        this.processFunctions(dataAsObjects);
        this.processImports(dataAsObjects);

        this.processFunctionCalls(dataAsObjects);
        this.processInheritance(dataAsObjects);

        console.log('✅ Processamento de relacionamentos concluído!');
        console.log('✅ enrichGraph - Nós processados:', this.nodes.length);
        console.log(
            '✅ enrichGraph - Relacionamentos processados:',
            this.relationships.size,
        );

        return {
            nodes: this.nodes,
            relationships: Array.from(this.relationships.values()),
        };
    }

    private extractFilePathAndIdentifier(fullPath: string): {
        filePath: string;
        identifier?: string;
    } {
        if (this.extractPathCache.has(fullPath)) {
            return this.extractPathCache.get(fullPath)!;
        }

        const match = fullPath.match(/^(.+\.[a-zA-Z0-9]+):(.+)$/);

        const result = match
            ? { filePath: match[1], identifier: match[2] }
            : { filePath: fullPath };

        this.extractPathCache.set(fullPath, result);

        return result;
    }

    private clearExtractPathCache(): void {
        this.extractPathCache.clear();
    }

    buildFunctionsAffect(
        impactedNodes: ImpactResult[],
        oldFunctionAnalyses: Map<string, FunctionAnalysis>,
        newFunctionAnalyses: Map<string, FunctionAnalysis>,
    ): FunctionsAffectResult[] {
        const finalResult: FunctionsAffectResult[] = [];

        for (const impacted of impactedNodes) {
            // 1) Nome da função alterada (ex.: "MinhaClasse.meuMetodo")
            const impactedFunctionName = impacted.function;

            // 2) Acessar o "nível 0" => é a função alterada em si
            //    Precisamos do "oldFunction" e do "newFunction"
            //    Localizamos no oldFunctionAnalyses e newFunctionAnalyses
            //    Caso não exista "className", ajusta a busca como preferir.

            const oldAnalysis = this.findFunctionAnalysisById(
                impactedFunctionName,
                oldFunctionAnalyses,
            );
            const newAnalysis = this.findFunctionAnalysisById(
                impactedFunctionName,
                newFunctionAnalyses,
            );

            const oldFunctionCode = this.generateFunctionWithLines(
                oldAnalysis?.fullText,
                oldAnalysis?.startLine,
                oldAnalysis?.endLine,
            );

            const newFunctionCode = this.generateFunctionWithLines(
                newAnalysis?.fullText,
                newAnalysis?.startLine,
                newAnalysis?.endLine,
            );

            // 3) Pegar todos os nós (flatten dos groupedByLevel)
            //    e filtrar para ignorar nível 0 (se não quiser repetí-lo)
            const allImpactedNodes = Object.values(
                impacted.impact.groupedByLevel,
            ).flat();
            // Se você quiser EXCLUIR a própria função alterada do “functionsAffect”:
            const affectedMethods = allImpactedNodes.filter(
                (node) => node.level > 0,
            );

            // 4) Mapear os nós impactados para o objeto `FunctionsAffect`
            const functionsAffect: FunctionsAffect[] = affectedMethods.map(
                (node) => {
                    const analysis = this.findFunctionAnalysisById(
                        node.id,
                        newFunctionAnalyses,
                    );
                    return {
                        functionName: node.id,
                        filePath: analysis?.file || '',
                        functionBody: this.generateFunctionWithLines(
                            analysis?.fullText,
                            analysis?.startLine,
                            analysis?.endLine,
                        ),
                    };
                },
            );

            // 5) Montar o objeto final
            finalResult.push({
                oldFunction: oldFunctionCode,
                newFunction: newFunctionCode,
                functionsAffect: functionsAffect
                    ? Object.values(functionsAffect)
                    : [],
            });
        }

        return finalResult;
    }

    /***********************************************
     * 3) Helper para localizar FunctionAnalysis
     ***********************************************/

    /**
     * Localiza um FunctionAnalysis combinando
     *  - ID do node (ex. "MinhaClasse.metodoX")
     *  - Campos do FunctionAnalysis (ex. className + name)
     *
     * Ajuste conforme a forma como você monta a “chave” no Record<string, FunctionAnalysis>.
     */
    findFunctionAnalysisById(
        nodeId: string,
        analysesRecord: Map<string, FunctionAnalysis>,
    ): FunctionAnalysis | undefined {
        // Exemplo simples:
        // Se nodeId = "MinhaClasse.metodoX", vamos dar split no '.' e comparar
        const [maybeClass, maybeMethod] = nodeId.split('.');
        const allAnalyses = Array.from(analysesRecord.values());
        // Se só existir “metodoX” sem classe, esse split retorna [ "metodoX" ] e maybeMethod fica undefined.
        // Ajuste se necessário.
        // Tente localizar no record um que bata com a className e name
        return allAnalyses.find((analysis) => {
            const hasSameFileAndName =
                // Se for algo do tipo "MinhaClasse.metodoX"
                (analysis.className === maybeClass &&
                    analysis.name === maybeMethod) ||
                // Se for só "metodoX"
                (analysis.name === maybeClass && !maybeMethod);

            return hasSameFileAndName;
        });
    }

    computeImpactAnalysis(
        graph: EnrichGraph,
        changeResults: ChangeResult[],
        depth: number = Infinity,
        direction: 'both' | 'forward' | 'backward' = 'backward',
        allowedTypes: RelationshipType[] = Array.from(
            new Set(graph.relationships.map((rel: any) => rel.type)),
        ),
    ): ImpactResult[] {
        const results: ImpactResult[] = [];

        for (const { modified, added, deleted } of changeResults) {
            const changedFunctions = [...modified, ...added, ...deleted];

            for (const func of changedFunctions) {
                const impactedNodes = this.dfs(
                    graph,
                    func.fullName,
                    direction,
                    allowedTypes,
                );

                if (impactedNodes.length === 0) {
                    continue;
                }

                // 🔄 3. Rastreia a propagação do impacto no grafo
                const impactReport = this.traceImpactPropagation(
                    graph,
                    func.fullName, // ✅ Passamos cada função alterada como startNode
                    impactedNodes,
                    allowedTypes,
                );

                // 🧠 4. Enriquecer com análise AST e armazenar o resultado
                const impactAnalysis = this.extractASTDependencies(
                    impactReport,
                    graph,
                    depth,
                );

                results.push({
                    function: func.fullName,
                    impact: impactAnalysis,
                });
            }
        }

        return results;
    }

    extractASTDependencies(
        impactReport: ImpactedNode[],
        graph: any,
        depth: number = Infinity,
    ): any {
        const groupedByLevel: Record<number, ImpactedNode[]> = {};
        const impactByType: Record<string, number> = {};

        impactReport
            .filter(
                (impact) =>
                    impact.type === NodeType.METHOD ||
                    impact.type === NodeType.FUNCTION,
            )
            ?.forEach((node) => {
                if (node.level > depth) {
                    return;
                }

                // 🔹 Agrupar por nível de propagação
                if (!groupedByLevel[node.level]) {
                    groupedByLevel[node.level] = [];
                }
                groupedByLevel[node.level].push(node);

                // 🔹 Contar quantos de cada tipo existem
                impactByType[node.type] = (impactByType[node.type] || 0) + 1;
            });

        return {
            summary: {
                totalImpact: Object.values(groupedByLevel).flat().length,
                highestLevel: Math.max(
                    ...Object.keys(groupedByLevel).map(Number),
                ),
                impactByType,
            },
            groupedByLevel,
        };
    }

    /**
     * Verifica se um nó está além do `maxLevel`
     */
    isBeyondMaxLevel(
        nodeId: string,
        impactReport: ImpactedNode[],
        maxLevel: number,
    ): boolean {
        const node = impactReport.find((n) => n.id === nodeId);
        return node ? node.level > maxLevel : false;
    }

    /**
     * Processa os imports de um arquivo
     */
    private processFileImports(filePath: string, fileData: any, data: any) {
        if (!fileData.imports || !fileData.imports.length) {
            return;
        }

        const normalizedFrom = this.normalizePath(filePath);
        const className = fileData.className?.[0];

        // Verificar se data é um CodeGraph (com Maps) ou um objeto
        if (data.files instanceof Map) {
            // Obter os dados do arquivo importado do Map
            const importedFileData = data.files.get(normalizedFrom);
            if (importedFileData && importedFileData.className) {
                const importedClassName = importedFileData.className[0];

                this.addRelationship(
                    className,
                    importedClassName,
                    RelationshipType.IMPORTS,
                    normalizedFrom,
                    normalizedFrom,
                );
            }
        } else {
            // Versão para objetos
            const importedFileData = data.files?.[normalizedFrom];
            if (importedFileData && importedFileData.className) {
                const importedClassName = importedFileData.className[0];

                this.addRelationship(
                    className,
                    importedClassName,
                    RelationshipType.IMPORTS,
                    normalizedFrom,
                    normalizedFrom,
                );
            }
        }
    }

    private processTypes(data: { types?: Record<string, any> }) {
        console.log('🔄 Processando classes e interfaces...');

        const normalizedTypes = new Map<
            string,
            {
                name: string;
                type: string;
                file: string;
                implements?: string[];
                extends?: string[];
                implementedBy?: string[];
            }
        >();

        Object.entries(data.types || {}).forEach(([key, type]) => {
            if (
                typeof type === 'object' &&
                type.name &&
                type.type &&
                type.file
            ) {
                const normalizedKey = this.normalizePath(key);
                normalizedTypes.set(normalizedKey, type);

                this.addNode(
                    type.name,
                    type.type === 'interface'
                        ? NodeType.INTERFACE
                        : NodeType.CLASS,
                    type.file.split('/').pop() || '',
                    type.file,
                );

                if (type.type === 'class') {
                    type.implements?.forEach((iface: string) => {
                        const { identifier } =
                            this.extractFilePathAndIdentifier(iface);
                        if (identifier && this.addedNodes[identifier]) {
                            this.addRelationship(
                                type.name,
                                identifier,
                                RelationshipType.IMPLEMENTS,
                                type.file,
                                iface,
                            );
                        }
                    });

                    type.extends?.forEach((baseClass: string) => {
                        const { identifier } =
                            this.extractFilePathAndIdentifier(baseClass);
                        if (identifier && this.addedNodes[identifier]) {
                            this.addRelationship(
                                type.name,
                                identifier,
                                RelationshipType.EXTENDS,
                                type.file,
                                baseClass,
                            );
                        }
                    });
                } else if (type.type === 'interface') {
                    type.implementedBy?.forEach((cls: string) => {
                        const { identifier } =
                            this.extractFilePathAndIdentifier(cls);
                        if (identifier && this.addedNodes[identifier]) {
                            this.addRelationship(
                                identifier,
                                type.name,
                                RelationshipType.IMPLEMENTED_BY,
                                type.file,
                                cls,
                            );
                        }
                    });
                }
            }
        });

        console.log('✅ Processamento de tipos concluído!');
    }

    private processImports(data: any) {
        for (const [filePath, fileData] of Object.entries(data.files || {})) {
            this.processFileImports(filePath, fileData, data);
        }
    }

    private processFunctionCalls(data: any) {
        for (const [funcKey, func] of Object.entries(data.functions || {})) {
            const typedFunc = func as FunctionData; // ✅ cast explícito

            const { filePath } = this.extractFilePathAndIdentifier(funcKey);

            if (!typedFunc.className || !typedFunc.name) {
                continue;
            }

            const methodId = `${typedFunc.className}.${typedFunc.name}`;

            for (const call of typedFunc.calls || []) {
                if (!call.function || !call.file) {
                    continue;
                }

                const { filePath: calledFilePath } =
                    this.extractFilePathAndIdentifier(call.file);

                // Processamento CALLS (Chamadas diretas)
                const calledId = this.findMethodId(
                    call.file,
                    call.function,
                    data,
                );

                if (calledId) {
                    this.addRelationship(
                        methodId,
                        calledId,
                        RelationshipType.CALLS,
                        filePath,
                        calledFilePath,
                    );
                }

                // Processamento CALLS_IMPLEMENTATION (Chamadas para interfaces implementadas)
                const implMethod = this.findImplementation(
                    call.file,
                    call.function,
                    data,
                );
                if (implMethod) {
                    this.addRelationship(
                        methodId,
                        implMethod.id,
                        RelationshipType.CALLS_IMPLEMENTATION,
                        filePath,
                        implMethod.filePath,
                    );
                }
            }
        }
    }

    private processFunctions(data: any) {
        console.log('🔍 processFunctions() iniciado');

        Object.entries(data.functions || {}).forEach(
            ([funcKey, func]: [string, any]) => {
                let className = func.className;
                let functionName = func.name;
                const filePath = func.file;

                // 🔹 Se `className` estiver ausente, tenta inferir a classe pelo arquivo
                if (!className) {
                    className = this.inferClassName(filePath, data);

                    if (!className) {
                        return;
                    }
                }

                if (!functionName) {
                    const { identifier: methodName } =
                        this.extractFilePathAndIdentifier(funcKey);

                    functionName = methodName;

                    return;
                }

                // Criar identificador do método
                const methodId = `${className}.${functionName}`;

                if (!this.addedNodes[methodId]) {
                    this.addNode(
                        methodId,
                        NodeType.METHOD,
                        filePath.split('/').pop() || '',
                        filePath,
                    );
                }

                // Relacionar método com a classe
                if (this.addedNodes[methodId]) {
                    this.addRelationship(
                        className,
                        methodId,
                        RelationshipType.HAS_METHOD,
                        filePath,
                        filePath,
                    );
                }
            },
        );

        console.log('✅ Processamento de funções concluído!');
    }

    private findMethodId(
        filePath: string,
        functionName: string,
        data: any,
    ): string | null {
        // Tenta encontrar a classe ou interface no arquivo
        const fileData = data.files?.[filePath];
        if (!fileData) return null;

        // Procura pela classe ou interface que define esse método
        const className = fileData.className?.[0] || 'undefined';

        return `${className}.${functionName}`;
    }

    private findImplementation(
        interfacePath: string,
        methodName: string,
        data: any,
    ): { id: string; filePath: string } | null {
        console.log(
            `🔎 Buscando implementação para ${interfacePath}.${methodName}`,
        );

        // Normalizar interfacePath removendo o nome da interface (se necessário)
        const matchingClasses = Object.entries(data.types || {}).filter(
            ([, type]: [string, any]) =>
                type.type === 'class' &&
                Array.isArray(type.implements) &&
                type.implements.some((impl: string) =>
                    impl.startsWith(`${interfacePath}:`),
                ), // Verifica se começa com o caminho
        );

        if (matchingClasses.length === 0) {
            console.error(
                `❌ ERRO: Nenhuma implementação encontrada para ${interfacePath}`,
            );
            return null;
        }

        // Pegar a primeira classe que implementa a interface
        const [implClassPath, implClass] = matchingClasses[0] as [
            string,
            { name: string },
        ];

        if (!implClass.name) {
            console.error(
                `❌ ERRO: Implementação sem nome em ${implClassPath}`,
            );
            return null;
        }

        // Buscar o método dentro da classe implementada
        const implMethodEntry = Object.entries(data.functions || {}).find(
            ([, func]: [string, any]) =>
                func.className === implClass.name && func.name === methodName,
        );

        if (!implMethodEntry) {
            console.error(
                `❌ ERRO: Método ${methodName} não encontrado em ${implClass.name}`,
            );
            return null;
        }

        const [, func] = implMethodEntry as [string, { file: string }];

        return {
            id: `${implClass.name}.${methodName}`,
            filePath: func.file,
        };
    }

    private processInheritance(data: any) {
        console.log('🔍 processInheritance() iniciado');

        Object.entries(data.types || {}).forEach(
            ([key, type]: [string, any]) => {
                if (
                    (type.type === 'class' && type.extends) ||
                    (type.type === 'interface' && type.extends)
                ) {
                    type.extends.forEach((baseClass: string) => {
                        if (this.addedNodes[type.name]) {
                            const { filePath, identifier } =
                                this.extractFilePathAndIdentifier(baseClass);

                            this.addRelationship(
                                type.name,
                                identifier,
                                RelationshipType.EXTENDS,
                                type.file,
                                identifier,
                            );
                        }
                    });
                }
            },
        );
    }

    // ----------------- Métodos Auxiliares -----------------
    private normalizePath(path: string): string {
        if (this.normalizedPathCache.has(path)) {
            return this.normalizedPathCache.get(path)!;
        }

        const normalized = path.trim().replace(/\\/g, '/');
        this.normalizedPathCache.set(path, normalized);

        return normalized;
    }

    private clearNormalizedPathCache(): void {
        this.normalizedPathCache.clear();
    }

    private addNode(
        id: string,
        type: EnrichGraphNode['type'],
        file: string,
        filePath: string,
    ) {
        if (!id || id === 'undefined') {
            console.warn(
                `⚠️ Tentativa de adicionar nó com ID inválido: ${filePath}`,
            );
            return;
        }
        if (!this.addedNodes[id]) {
            // ✅ Agora correto!
            this.nodes.push({ id, type, file, filePath });
            this.addedNodes[id] = true; // ✅ Marca que já foi adicionado
        }
    }

    private addRelationship(
        from: string,
        to: string,
        type: RelationshipType,
        fromPath: string,
        toPath: string,
    ) {
        if (!this.addedNodes[from] || !this.addedNodes[to]) {
            return;
        }

        const key = `${from}:${to}:${type}`;
        if (!this.relationshipKeys[key]) {
            this.relationships.set(key, { from, to, type, fromPath, toPath });
            this.relationshipKeys[key] = true;
        }
    }

    private jaccardSimilarity(s1: string, s2: string): number {
        // Tokeniza a string usando uma expressão regular que separa por caracteres não alfanuméricos.
        const tokens1 = new Set(
            s1.split(/\W+/).filter((token) => token.length > 0),
        );
        const tokens2 = new Set(
            s2.split(/\W+/).filter((token) => token.length > 0),
        );

        // Calcula a interseção dos tokens
        const intersection = new Set(
            [...tokens1].filter((token) => tokens2.has(token)),
        );
        // Calcula a união dos tokens
        const union = new Set([...tokens1, ...tokens2]);

        return union.size === 0 ? 1 : intersection.size / union.size;
    }

    private groupByPropagation(
        graph: EnrichGraph,
        startNode: string,
        impactedNodes: string[],
    ): Record<number, string[]> {
        const levels: Record<number, string[]> = {};
        const queue: { node: string; level: number }[] = [
            { node: startNode, level: 0 },
        ];
        const visited = new Set<string>();

        while (queue.length) {
            const { node, level } = queue.shift()!;
            if (visited.has(node)) continue;
            visited.add(node);

            if (!levels[level]) levels[level] = [];
            levels[level].push(node);

            for (const edge of graph.relationships) {
                if (edge.to === node && impactedNodes.includes(edge.from)) {
                    queue.push({ node: edge.from, level: level + 1 });
                }
            }
        }

        return levels;
    }

    /**
     * **Classifica os nós impactados usando AST e relacionamentos**
     */
    classifyNodeType(graph: any, nodeId: string): string {
        // 🔍 Busca o nó no grafo
        const node = graph.nodes.find((n: any) => n.id === nodeId);
        if (!node) return 'Unknown';

        // Se o nó tem tipo explícito (extraído do AST), usamos ele
        if (node.type) return node.type;

        // 🔗 Verifica se esse nó está relacionado a um "método" ou "classe"
        const relatedEdges = graph.relationships.filter(
            (rel: any) => rel.from === nodeId || rel.to === nodeId,
        );

        // Se tem relacionamento do tipo HAS_METHOD, provavelmente é uma classe
        if (relatedEdges.some((rel: any) => rel.type === 'HAS_METHOD'))
            return 'Class';

        // Se tem relacionamento CALLS, provavelmente é uma função/método
        if (relatedEdges.some((rel: any) => rel.type === 'CALLS'))
            return 'Method';

        return 'Unknown';
    }

    /**
     * **Determina a severidade do impacto baseando-se em conexões**
     */
    determineSeverity(graph: any, nodeId: string): string {
        const relatedEdges = graph.relationships.filter(
            (rel: any) => rel.from === nodeId || rel.to === nodeId,
        );

        if (
            relatedEdges.some(
                (rel: any) =>
                    rel.type === 'CALLS' || rel.type === 'CALLS_IMPLEMENTATION',
            )
        ) {
            return 'high'; // 🔴 Impacto crítico
        }

        if (
            relatedEdges.some(
                (rel: any) =>
                    rel.type === 'IMPLEMENTS' ||
                    rel.type === 'EXTENDS' ||
                    rel.type === 'IMPLEMENTED_BY',
            )
        ) {
            return 'medium'; // 🟠 Impacto médio (herança, interface)
        }

        return 'low'; // 🟢 Impacto baixo (importações, referências passivas)
    }

    /**
     * **Gera um relatório completo de impacto**
     */
    traceImpactPropagation(
        graph: EnrichGraph,
        startNode: string,
        impactedNodes: string[],
        allowedTypes: RelationshipType[],
    ): ImpactedNode[] {
        const levels = this.groupByPropagation(graph, startNode, impactedNodes);

        return impactedNodes
            .filter((nodeId) => {
                // 🔎 Localiza o nó no grafo
                const node = graph.nodes.find((n) => n.id === nodeId);

                if (!node) {
                    return false;
                }

                // 🔥 Aqui focamos apenas em métodos/funções.
                // Se o node.type não for 'Method' ou 'Function', a gente ignora.
                return (
                    node.type === NodeType.METHOD ||
                    node.type === NodeType.FUNCTION
                );
            })
            .map((nodeId) => {
                const node = graph.nodes.find((n: any) => n.id === nodeId);

                // 🔥 Buscar imports relevantes
                const importRelationships = graph.relationships.filter(
                    (rel: any) =>
                        rel.type === RelationshipType.IMPORTS &&
                        rel.to === nodeId &&
                        allowedTypes.includes(rel.type),
                );

                return {
                    id: nodeId,
                    type: node?.type,
                    severity: this.determineSeverity(graph, nodeId),
                    level: Number(
                        Object.entries(levels).find(([_, nodes]) =>
                            nodes.includes(nodeId),
                        )?.[0] ?? -1,
                    ),
                    filePath: node?.filePath,
                    calledBy: this.getCalledByMethods(graph, nodeId),
                    importedBy: importRelationships.map((rel: any) => rel.from),
                };
            });
    }

    private getCalledByMethods(graph: EnrichGraph, methodId: string): string[] {
        // 1) Filtra relacionamentos do tipo CALLS onde 'to' seja o 'methodId'
        const callersIds = graph.relationships
            .filter(
                (rel) =>
                    rel.type === RelationshipType.CALLS && rel.to === methodId,
            )
            .map((rel) => rel.from);

        // 2) Filtra nós cujo ID esteja em callersIds e cujo tipo seja 'Method' ou 'Function'
        const callerNodes = graph.nodes.filter(
            (node) =>
                callersIds.includes(node.id) &&
                (node.type === NodeType.METHOD ||
                    node.type === NodeType.FUNCTION),
        );

        // 3) Retorna apenas o campo 'id' de cada nó
        return callerNodes.map((node) => node.id);
    }

    private async createChainWithFallback(context: {
        organizationAndTeamData: OrganizationAndTeamData;
        pullRequest: any;
        functions: {
            addedFunction: {
                name: string;
                lines: number;
                fullText: string;
            };
            existingFunctions: {
                name: string;
                lines: number;
                fullText: string;
            }[];
        };
    }) {
        try {
            const mainChain = await this.createProviderChain(
                LLMModelProvider.DEEPSEEK_V3,
                JSON.stringify(context.functions),
            );
            const fallbackChain = await this.createProviderChain(
                LLMModelProvider.CHATGPT_4_ALL,
                JSON.stringify(context.functions),
            );

            // Usar withFallbacks para configurar o fallback corretamente
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'analyzeCodeWithAI',
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis chain with fallback',
                error,
                context: CodeAnalyzerService.name,
                metadata: {
                    provider: LLMModelProvider.DEEPSEEK_V3,
                    fallbackProvider: LLMModelProvider.CHATGPT_4_ALL,
                },
            });
            throw error;
        }
    }

    private async createProviderChain(
        provider: LLMModelProvider,
        context: string,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                          temperature: 0,
                      })
                    : getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                      });

            if (provider === LLMModelProvider.CHATGPT_4_ALL) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    return [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: prompt_checkSimilarFunctions_system(
                                        context,
                                    ),
                                },
                            ],
                        },
                    ];
                },
                llm,
                new JsonOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis code chain',
                error,
                context: CodeAnalyzerService.name,
                metadata: { provider },
            });
            throw error;
        }
    }
    /**
     * Analyzes the complexity of a function node in the AST
     * @param node The function node to analyze
     * @returns Complexity analysis including cyclomatic and cognitive complexity
     */
    public analyzeFunctionComplexity(node: SyntaxNode): ComplexityAnalysis {
        if (!node) {
            throw new Error('Invalid node provided');
        }

        const analysis: ComplexityAnalysis = {
            cyclomaticComplexity: 1,
            cognitiveComplexity: 0,
            details: {
                conditionals: 0,
                loops: 0,
                switches: 0,
                catches: 0,
                logicalOperators: 0,
                recursion: false,
            },
        };

        let nestingLevel = 0;

        const analyzeNode = (n: SyntaxNode, depth: number = 0): void => {
            // Check for recursion
            if (depth === 0 && n.type === 'function_declaration') {
                const functionName = n.children.find(
                    (c) => c.type === 'identifier',
                )?.text;
                if (functionName) {
                    const functionCalls = n.children.filter(
                        (c) =>
                            c.type === 'call_expression' &&
                            c.children[0]?.text === functionName,
                    );
                    analysis.details.recursion = functionCalls.length > 0;
                }
            }

            switch (n.type) {
                case 'if_statement':
                    analysis.cyclomaticComplexity++;
                    analysis.cognitiveComplexity += 1 + nestingLevel;
                    analysis.details.conditionals++;
                    nestingLevel++;
                    break;

                case 'while_statement':
                case 'for_statement':
                case 'for_in_statement':
                case 'for_of_statement':
                    analysis.cyclomaticComplexity++;
                    analysis.cognitiveComplexity += 1 + nestingLevel;
                    analysis.details.loops++;
                    nestingLevel++;
                    break;

                case 'switch_statement':
                    analysis.details.switches++;
                    n.children
                        .filter((child) => child.type === 'case')
                        .forEach(() => {
                            analysis.cyclomaticComplexity++;
                            analysis.cognitiveComplexity++;
                        });
                    break;

                case 'catch_clause':
                    analysis.cyclomaticComplexity++;
                    analysis.cognitiveComplexity++;
                    analysis.details.catches++;
                    break;

                case 'binary_expression':
                    const operators = ['&&', '||'];
                    if (operators.includes(n.text)) {
                        analysis.cyclomaticComplexity++;
                        analysis.details.logicalOperators++;
                    }
                    break;
            }

            n.children.forEach((child) => analyzeNode(child, depth + 1));

            // Decrease nesting level after processing nested structures
            switch (n.type) {
                case 'if_statement':
                case 'while_statement':
                case 'for_statement':
                case 'for_in_statement':
                case 'for_of_statement':
                    nestingLevel--;
                    break;
            }
        };

        try {
            analyzeNode(node);
            return analysis;
        } catch (error) {
            throw new Error(
                `Failed to analyze function complexity: ${error.message}`,
            );
        }
    }

    /**
     * Analyzes the scope of a node, identifying variables, functions, and dependencies
     * @param node The node to analyze scope for
     * @returns Scope analysis with variables, functions, and dependencies
     */
    public analyzeScope(node: SyntaxNode): ScopeAnalysis {
        if (!node) {
            throw new Error('Invalid node provided');
        }

        const scope: ScopeAnalysis = {
            variables: [],
            functions: [],
            dependencies: [],
        };

        const variableSet = new Set<string>();
        const functionSet = new Set<string>();
        const dependencySet = new Set<string>();

        const analyzeNode = (n: SyntaxNode): void => {
            switch (n.type) {
                case 'variable_declaration':
                case 'let_declaration':
                case 'const_declaration':
                    n.children
                        .filter((child) => child.type === 'identifier')
                        .forEach((id) => variableSet.add(id.text));
                    break;

                case 'function_declaration':
                case 'method_definition':
                case 'arrow_function':
                    const name = n.children.find(
                        (child) =>
                            child.type === 'identifier' ||
                            child.type === 'property_identifier',
                    );
                    if (name) {
                        functionSet.add(name.text);
                    }
                    break;

                case 'import_statement':
                case 'import_declaration':
                    const importPath = n.children.find(
                        (child) =>
                            child.type === 'string' ||
                            child.type === 'string_literal',
                    );
                    if (importPath) {
                        const path = importPath.text.replace(/['"\`]/g, '');
                        if (!path.startsWith('.') && !path.startsWith('/')) {
                            dependencySet.add(path);
                        }
                    }
                    break;
            }

            n.children.forEach(analyzeNode);
        };

        try {
            analyzeNode(node);
            scope.variables = Array.from(variableSet);
            scope.functions = Array.from(functionSet);
            scope.dependencies = Array.from(dependencySet);
            return scope;
        } catch (error) {
            throw new Error(`Failed to analyze scope: ${error.message}`);
        }
    }

    /**
     * Extracts import statements from an AST
     * @param ast The abstract syntax tree to analyze
     * @returns Array of imported identifiers
     */
    public extractImports(ast: SyntaxNode): string[] {
        if (!ast) {
            throw new Error('Invalid AST provided');
        }

        const imports: string[] = [];

        const traverse = (node: SyntaxNode): void => {
            if (!node || !node.type) return;

            if (node.type === 'import_statement') {
                // Find named imports
                const namedImports = node.children?.find(
                    (child: SyntaxNode) => child.type === 'import_clause',
                );

                if (namedImports) {
                    // Extract individual import names
                    namedImports.children?.forEach((importNode: SyntaxNode) => {
                        if (importNode.type === 'identifier') {
                            imports.push(importNode.text);
                        }
                    });
                }
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(traverse);
            }
        };

        traverse(ast);
        return imports;
    }

    /**
     * Extracts functions used (called) in the AST
     * @param ast The abstract syntax tree of the current file
     * @returns Array of function names that are called
     */
    public extractUsedFunctions(ast: SyntaxNode): string[] {
        if (!ast) {
            throw new Error('Invalid AST provided');
        }

        const usedFunctions: string[] = [];

        const traverse = (node: SyntaxNode): void => {
            if (!node || !node.type) return;

            // If the node is a function call, add it to the used functions array
            if (node.type === 'call_expression') {
                const functionNameNode = node.children?.[0];
                if (
                    functionNameNode &&
                    functionNameNode.type === 'identifier'
                ) {
                    usedFunctions.push(functionNameNode.text);
                }
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(traverse);
            }
        };

        traverse(ast);
        return usedFunctions;
    }

    /**
     * Extracts function declarations from the AST
     * @param ast The abstract syntax tree to analyze
     * @returns Array of function information including name, node, and signature
     */
    public extractFunctions(
        ast: SyntaxNode,
    ): { name: string; node: SyntaxNode; signature: string }[] {
        if (!ast) {
            throw new Error('Invalid AST provided');
        }

        const functions: {
            name: string;
            node: SyntaxNode;
            signature: string;
        }[] = [];

        const traverse = (node: SyntaxNode): void => {
            if (!node || !node.type) return;

            // Check for function declarations
            if (
                node.type === 'function_declaration' ||
                node.type === 'method_definition'
            ) {
                const nameNode = node.children.find(
                    (child: SyntaxNode) => child.type === 'identifier',
                );
                if (nameNode) {
                    functions.push({
                        name: nameNode.text,
                        node: node,
                        signature: node.text,
                    });
                }
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(traverse);
            }
        };

        traverse(ast);
        return functions;
    }

    /**
     * Detects imports that are declared but not used in the code
     * @param ast The abstract syntax tree to analyze
     * @returns Array of unused imports
     */
    public detectUnusedImports(ast: SyntaxNode): { functionName: string }[] {
        if (!ast) {
            throw new Error('Invalid AST provided');
        }

        const unusedImports: { functionName: string }[] = [];
        const importedFunctions = this.extractImports(ast);
        const usedFunctions = this.extractUsedFunctions(ast);

        const unused = importedFunctions.filter(
            (importName) => !usedFunctions.includes(importName),
        );

        unused.forEach((func) => {
            unusedImports.push({
                functionName: func,
            });
        });

        return unusedImports;
    }

    /**
     * Detects functions used but not imported
     * @param ast The abstract syntax tree of the current file
     * @param utilAst The abstract syntax tree of a utility file that might contain the functions
     * @returns Array of missing imports with function name and source file
     */
    public detectMissingImports(
        ast: SyntaxNode,
        utilAst: SyntaxNode,
    ): { functionName: string; definedInFile: string }[] {
        if (!ast) {
            throw new Error('Invalid AST provided');
        }

        const missingImports: {
            functionName: string;
            definedInFile: string;
        }[] = [];

        if (!utilAst) {
            return missingImports;
        }

        const utilFunctions = this.extractFunctions(utilAst);
        const usedFunctions = this.extractUsedFunctions(ast);
        const importedFunctions = this.extractImports(ast);

        usedFunctions.forEach((funcName) => {
            const foundInUtil = utilFunctions.find((f) => f.name === funcName);
            if (foundInUtil && !importedFunctions.includes(funcName)) {
                missingImports.push({
                    functionName: funcName,
                    definedInFile: 'util.ts',
                });
            }
        });

        return missingImports;
    }

    generateFunctionWithLines(
        code: string,
        lineStart: number,
        lineEnd: number,
    ): string {
        const lines = code?.split('\n');

        return lines
            ?.map((line, index) => `${lineStart + index} ${line}`)
            ?.join('\n');
    }

    /**
     * Infere o nome da classe a partir do caminho do arquivo
     */
    private inferClassName(filePath: string, data: any): string | null {
        // Se data for um CodeGraph (com Maps)
        if (data.files instanceof Map) {
            return this.inferClassNameFromMap(filePath, data);
        }

        // Versão original para objetos
        const foundClass = Object.values(data.types || {}).find(
            (type: any) =>
                type && type.file === filePath && type.type === 'class',
        ) as { name?: string } | undefined;

        return foundClass?.name || null;
    }

    /**
     * Infere o nome da classe a partir do caminho do arquivo (versão para Map)
     */
    private inferClassNameFromMap(
        filePath: string,
        data: CodeGraph,
    ): string | null {
        // Normalizar o caminho para garantir consistência
        const normalizedPath = this.normalizePath(filePath);

        // Obter os dados do arquivo
        const fileData = data.files.get(normalizedPath);
        if (!fileData || !fileData.className || !fileData.className.length) {
            return null;
        }

        return fileData.className[0];
    }
}
