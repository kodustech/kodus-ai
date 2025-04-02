import { Injectable } from '@nestjs/common';
import { SyntaxNode } from 'tree-sitter';

interface ComplexityMetrics {
    cyclomaticComplexity: number;
    cognitiveComplexity: number;
    maintainabilityIndex: number;
}

interface CodeSmell {
    type: string;
    message: string;
    location: {
        file: string;
        line?: number;
        column?: number;
    };
    severity: 'low' | 'medium' | 'high';
}

@Injectable()
export class CodeQualityAnalyzerService {
    private readonly COMPLEXITY_THRESHOLD = 10;
    private readonly MAX_LINES = 50;
    private readonly MAX_PARAMETERS = 4;
    private readonly MAX_NESTING_DEPTH = 3;

    constructor() { }

    /**
     * Analisa a complexidade ciclomática de uma função
     * Baseado no número de caminhos possíveis através do código
     */
    analyzeCyclomaticComplexity(ast: SyntaxNode): ComplexityMetrics {
        let complexity = 1; // Base complexity
        let maxNestingDepth = 0;
        let currentNestingDepth = 0;
        let parameterCount = 0;
        let linesOfCode = 0;

        const traverse = (node: SyntaxNode) => {
            if (!node) return;

            // Incrementa complexidade para estruturas de controle
            if (
                node.type === 'if_statement' ||
                node.type === 'while_statement' ||
                node.type === 'for_statement' ||
                node.type === 'catch_clause' ||
                node.type === '&&' ||
                node.type === '||'
            ) {
                complexity++;
                currentNestingDepth++;
                maxNestingDepth = Math.max(maxNestingDepth, currentNestingDepth);
            }

            // Conta parâmetros em funções
            if (node.type === 'parameter') {
                parameterCount++;
            }

            // Conta linhas de código
            if (node.startPosition && node.endPosition) {
                linesOfCode += node.endPosition.row - node.startPosition.row + 1;
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(traverse);
            }

            if (
                node.type === 'if_statement' ||
                node.type === 'while_statement' ||
                node.type === 'for_statement' ||
                node.type === 'catch_clause'
            ) {
                currentNestingDepth--;
            }
        };

        traverse(ast);

        return {
            cyclomaticComplexity: complexity,
            cognitiveComplexity: 0,
            maintainabilityIndex: 0,
        };
    }

    /**
     * Detecta code smells baseado nas métricas de complexidade
     */
    detectCodeSmells(
        file: string,
        functionName: string,
        metrics: ComplexityMetrics,
    ): CodeSmell[] {
        const smells: CodeSmell[] = [];

        // Verifica complexidade ciclomática alta
        if (metrics.cyclomaticComplexity > this.COMPLEXITY_THRESHOLD) {
            smells.push({
                type: 'high_complexity',
                message: `A função "${functionName}" tem complexidade ciclomática alta (${metrics.cyclomaticComplexity}). Considere dividir em funções menores.`,
                location: { file },
                severity: 'high',
            });
        }

        // Verifica funções muito longas
        if (metrics.maintainabilityIndex > this.MAX_LINES) {
            smells.push({
                type: 'long_function',
                message: `A função "${functionName}" é muito longa (${metrics.maintainabilityIndex} linhas). Considere dividir em funções menores.`,
                location: { file },
                severity: 'medium',
            });
        }

        // Verifica muitos parâmetros
        if (metrics.cognitiveComplexity > this.MAX_PARAMETERS) {
            smells.push({
                type: 'too_many_parameters',
                message: `A função "${functionName}" tem muitos parâmetros (${metrics.cognitiveComplexity}). Considere usar um objeto de configuração.`,
                location: { file },
                severity: 'medium',
            });
        }

        // Verifica profundidade de aninhamento
        if (metrics.cyclomaticComplexity > this.MAX_NESTING_DEPTH) {
            smells.push({
                type: 'deep_nesting',
                message: `A função "${functionName}" tem aninhamento profundo (${metrics.cyclomaticComplexity} níveis). Considere extrair funções ou simplificar a lógica.`,
                location: { file },
                severity: 'medium',
            });
        }

        return smells;
    }

    /**
     * Detecta dependências circulares entre arquivos
     */
    detectCircularDependencies(
        imports: Map<string, Set<string>>,
    ): { from: string; to: string }[] {
        const visited = new Set<string>();
        const stack = new Set<string>();
        const cycles: { from: string; to: string }[] = [];

        const dfs = (file: string, path: string[] = []) => {
            if (stack.has(file)) {
                const cycleStart = path.indexOf(file);
                for (let i = cycleStart; i < path.length - 1; i++) {
                    cycles.push({
                        from: path[i],
                        to: path[i + 1],
                    });
                }
                return;
            }

            if (visited.has(file)) return;

            visited.add(file);
            stack.add(file);
            path.push(file);

            const dependencies = imports.get(file) || new Set();
            for (const dep of dependencies) {
                dfs(dep, [...path]);
            }

            stack.delete(file);
            path.pop();
        };

        for (const file of imports.keys()) {
            if (!visited.has(file)) {
                dfs(file);
            }
        }

        return cycles;
    }

    /**
     * Detecta padrões que podem ser refatorados
     */
    detectRefactoringOpportunities(ast: SyntaxNode, filename: string): CodeSmell[] {
        const smells: CodeSmell[] = [];
        const switchCases = new Map<string, number>();
        const catchBlocks = new Map<string, number>();

        const traverse = (node: SyntaxNode) => {
            if (!node) return;

            // Detecta switch statements com muitos cases
            if (node.type === 'switch_statement') {
                const caseCount = (node.children || []).filter(
                    (child) => child.type === 'case',
                ).length;
                if (caseCount > 5) {
                    smells.push({
                        type: 'large_switch',
                        message: `Switch statement com ${caseCount} cases. Considere usar um objeto de mapeamento ou padrão Strategy.`,
                        location: {
                            file: filename,
                            line: node.startPosition?.row,
                        },
                        severity: 'medium',
                    });
                }
            }

            // Detecta blocos catch duplicados
            if (node.type === 'catch_clause') {
                const catchBody = node.children
                    ?.find((child) => child.type === 'statement_block')
                    ?.text?.trim();
                if (catchBody) {
                    const count = (catchBlocks.get(catchBody) || 0) + 1;
                    catchBlocks.set(catchBody, count);
                    if (count > 1) {
                        smells.push({
                            type: 'duplicate_catch',
                            message: 'Blocos catch duplicados encontrados. Considere extrair para uma função de tratamento de erro.',
                            location: {
                                file: filename,
                                line: node.startPosition?.row,
                            },
                            severity: 'low',
                        });
                    }
                }
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(traverse);
            }
        };

        traverse(ast);
        return smells;
    }

    /**
     * Analisa se duas funções são semanticamente similares
     * Compara estrutura, parâmetros, lógica e padrões de código
     */
    analyzeFunctionSimilarity(func1: SyntaxNode, func2: SyntaxNode): {
        isSimilar: boolean;
        similarity: number;
        differences?: {
            parameters?: boolean;
            returnType?: boolean;
            logic?: boolean;
            structuralChanges?: string[];
            complexity?: boolean;
            patterns?: string[];
            dependencies?: boolean;
        };
    } {
        if (!func1 || !func2) return { isSimilar: false, similarity: 0 };

        const differences: any = {};
        let similarityScore = 0;

        // Compara parâmetros (20%)
        const params1 = this.extractParameters(func1);
        const params2 = this.extractParameters(func2);
        const paramsSimilarity = this.compareParameters(params1, params2);
        differences.parameters = paramsSimilarity < 1;
        similarityScore += paramsSimilarity * 0.2;

        // Compara tipo de retorno (10%)
        const return1 = this.extractReturnType(func1);
        const return2 = this.extractReturnType(func2);
        const returnSimilarity = return1 === return2 ? 1 : 0;
        differences.returnType = returnSimilarity < 1;
        similarityScore += returnSimilarity * 0.1;

        // Compara estrutura e lógica do código (40%)
        const structuralDiff = this.compareStructure(func1, func2);
        differences.structuralChanges = structuralDiff.changes;
        differences.logic = structuralDiff.changes.length > 0;
        similarityScore += (1 - structuralDiff.changes.length / 10) * 0.4;

        // Compara complexidade (10%)
        const complexity1 = this.analyzeFunctionComplexity(func1);
        const complexity2 = this.analyzeFunctionComplexity(func2);
        const complexitySimilarity = this.compareComplexity(complexity1, complexity2);
        differences.complexity = complexitySimilarity < 0.8;
        similarityScore += complexitySimilarity * 0.1;

        // Compara padrões de código (10%)
        const patterns1 = this.detectCodePatterns(func1);
        const patterns2 = this.detectCodePatterns(func2);
        const patternDiff = this.comparePatterns(patterns1, patterns2);
        if (patternDiff.differences.length > 0) {
            differences.patterns = patternDiff.differences;
        }
        similarityScore += patternDiff.similarity * 0.1;

        // Compara dependências externas (10%)
        const deps1 = this.extractDependencies(func1);
        const deps2 = this.extractDependencies(func2);
        const depsSimilarity = this.compareDependencies(deps1, deps2);
        differences.dependencies = depsSimilarity < 1;
        similarityScore += depsSimilarity * 0.1;

        return {
            isSimilar: similarityScore > 0.85, // Aumentado para 85% para maior precisão
            similarity: similarityScore,
            differences: Object.keys(differences).length > 0 ? differences : undefined,
        };
    }

    async detectDuplicateCode(
        filesASTs: { file: string; ast: any }[],
        allProjectFilesAST: { file: string; ast: any }[],
    ) {
        const duplicates: {
            functionName: string;
            occurrences: {
                file: string;
                signature: string;
            }[];
            similarity: number;
            differences?: {
                parameters?: boolean;
                returnType?: boolean;
                logic?: boolean;
                structuralChanges?: string[];
                complexity?: boolean;
                patterns?: string[];
                dependencies?: boolean;
            };
        }[] = [];

        // Map all functions by name
        const functionsByName = new Map<
            string,
            { file: string; node: any; signature: string }[]
        >();

        for (const { file, ast } of allProjectFilesAST) {

        }

        // Analyze each function for duplicates
        for (const [functionName, occurrences] of functionsByName.entries()) {
            if (occurrences.length > 1) {
                const hasModifiedFile = occurrences.some((occ) =>
                    filesASTs.some((f) => f.file === occ.file),
                );

                if (hasModifiedFile) {
                    for (let i = 0; i < occurrences.length - 1; i++) {
                        const func1 = occurrences[i];
                        for (let j = i + 1; j < occurrences.length; j++) {
                            const func2 = occurrences[j];

                            const analysis = this.analyzeFunctionSimilarity(
                                func1.node,
                                func2.node,
                            );

                            if (analysis.isSimilar) {
                                duplicates.push({
                                    functionName,
                                    occurrences: [
                                        { file: func1.file, signature: func1.signature },
                                        { file: func2.file, signature: func2.signature },
                                    ],
                                    similarity: analysis.similarity,
                                    differences: analysis.differences,
                                });
                            }
                        }
                    }
                }
            }
        }

        return duplicates.sort((a, b) => b.similarity - a.similarity);
    }

    analyzeCodeQuality(filesASTs: { file: string; ast: any }[]) {
        const codeQuality: {
            file: string;
            functions: {
                name: string;
                metrics: {
                    cyclomaticComplexity: number;
                    cognitiveComplexity: number;
                    maintainabilityIndex: number;
                };
                codeSmells: string[];
            }[];
        }[] = [];

        filesASTs.forEach(({ file, ast }) => {
            const fileQuality = {
                file,

            };

        });

        return codeQuality;
    }

    private analyzeFunctionComplexity(node: SyntaxNode): {
        cyclomaticComplexity: number;
        cognitiveComplexity: number;
        maintainabilityIndex: number;
    } {
        let cyclomaticComplexity = 1;
        let cognitiveComplexity = 0;
        let currentDepth = 0;

        const traverse = (n: SyntaxNode, isNested: boolean = false) => {
            if (!n) return;

            // Incrementa complexidade ciclomática
            if (this.isDecisionPoint(n)) {
                cyclomaticComplexity++;
                cognitiveComplexity += isNested ? 2 : 1;
            }

            // Incrementa complexidade cognitiva para estruturas de controle aninhadas
            if (this.isControlStructure(n)) {
                cognitiveComplexity += currentDepth;
                currentDepth++;
            }

            if (n.children) {
                n.children.forEach(child => traverse(child, true));
            }

            if (this.isControlStructure(n)) {
                currentDepth--;
            }
        };

        traverse(node);

        // Calculate maintainability index (simplified version)
        // Using the Microsoft formula: MAX(0,(171 - 5.2 * ln(CC) - 0.23 * (CC) - 16.2 * ln(LOC))*100 / 171)
        const loc = this.countLines(node);
        const maintainabilityIndex = Math.max(0,
            (171 - 5.2 * Math.log(cyclomaticComplexity)
                - 0.23 * cyclomaticComplexity
                - 16.2 * Math.log(loc)) * 100 / 171
        );

        return {
            cyclomaticComplexity,
            cognitiveComplexity,
            maintainabilityIndex
        };
    }

    private countLines(node: SyntaxNode): number {
        if (!node.startPosition || !node.endPosition) return 1;
        return node.endPosition.row - node.startPosition.row + 1;
    }

    private compareComplexity(
        c1: ReturnType<typeof this.analyzeFunctionComplexity>,
        c2: ReturnType<typeof this.analyzeFunctionComplexity>,
    ): number {
        const ccDiff = Math.abs(c1.cyclomaticComplexity - c2.cyclomaticComplexity);
        const cogDiff = Math.abs(c1.cognitiveComplexity - c2.cognitiveComplexity);
        const depthDiff = Math.abs(c1.maintainabilityIndex - c2.maintainabilityIndex);

        return 1 - (ccDiff * 0.4 + cogDiff * 0.4 + depthDiff * 0.2) / 10;
    }

    private detectCodePatterns(node: SyntaxNode): Set<string> {
        const patterns = new Set<string>();

        // Detecta padrões comuns
        const traverse = (n: SyntaxNode) => {
            if (!n) return;

            // Padrão Builder
            if (this.isBuilderPattern(n)) {
                patterns.add('builder');
            }

            // Padrão Factory
            if (this.isFactoryPattern(n)) {
                patterns.add('factory');
            }

            // Padrão Observer
            if (this.isObserverPattern(n)) {
                patterns.add('observer');
            }

            // Padrão Singleton
            if (this.isSingletonPattern(n)) {
                patterns.add('singleton');
            }

            // Callback Pattern
            if (this.isCallbackPattern(n)) {
                patterns.add('callback');
            }

            if (Array.isArray(n.children)) {
                n.children.forEach(traverse);
            }
        };

        traverse(node);
        return patterns;
    }

    private comparePatterns(
        patterns1: Set<string>,
        patterns2: Set<string>,
    ): { similarity: number; differences: string[] } {
        const differences: string[] = [];
        const union = new Set([...patterns1, ...patterns2]);
        const intersection = new Set(
            [...patterns1].filter(x => patterns2.has(x)),
        );

        // Encontra padrões diferentes
        for (const pattern of union) {
            if (patterns1.has(pattern) !== patterns2.has(pattern)) {
                differences.push(
                    `Padrão ${pattern} presente apenas em ${patterns1.has(pattern) ? 'primeira' : 'segunda'
                    } função`,
                );
            }
        }

        return {
            similarity: intersection.size / union.size || 1,
            differences,
        };
    }

    private extractDependencies(node: SyntaxNode): Set<string> {
        const dependencies = new Set<string>();

        const traverse = (n: SyntaxNode) => {
            if (!n) return;

            // Chamadas de método em objetos
            if (n.type === 'member_expression') {
                const object = n.children?.[0]?.text;
                if (object) dependencies.add(object);
            }

            // Imports
            if (n.type === 'import_statement') {
                const importPath = n.children?.find(c => c.type === 'string')?.text;
                if (importPath) dependencies.add(importPath);
            }

            if (Array.isArray(n.children)) {
                n.children.forEach(traverse);
            }
        };

        traverse(node);
        return dependencies;
    }

    private compareDependencies(deps1: Set<string>, deps2: Set<string>): number {
        if (deps1.size === 0 && deps2.size === 0) return 1;
        const union = new Set([...deps1, ...deps2]);
        const intersection = new Set(
            [...deps1].filter(x => deps2.has(x)),
        );
        return intersection.size / union.size;
    }

    private isDecisionPoint(node: SyntaxNode): boolean {
        return (
            node.type === 'if_statement' ||
            node.type === 'while_statement' ||
            node.type === 'for_statement' ||
            node.type === 'switch_statement' ||
            node.type === '&&' ||
            node.type === '||'
        );
    }

    private isControlStructure(node: SyntaxNode): boolean {
        return (
            this.isDecisionPoint(node) ||
            node.type === 'try_statement' ||
            node.type === 'catch_clause'
        );
    }

    private isBuilderPattern(node: SyntaxNode): boolean {
        // Verifica se há métodos que retornam this
        return node.type === 'return_statement' &&
            node.children?.some(c => c.type === 'this');
    }

    private isFactoryPattern(node: SyntaxNode): boolean {
        // Verifica se há criação de objetos baseada em condições
        return node.type === 'new_expression' &&
            this.hasParentConditional(node);
    }

    private isObserverPattern(node: SyntaxNode): boolean {
        // Verifica se há arrays de callbacks/listeners
        return node.type === 'array' &&
            node.children?.some(c => c.type === 'function');
    }

    private isSingletonPattern(node: SyntaxNode): boolean {
        // Verifica se há uma instância estática e um construtor privado
        return node.type === 'class_declaration' &&
            node.children?.some(c =>
                c.type === 'private_property_definition' &&
                c.children?.some(cc => cc.type === 'static')
            );
    }

    private isCallbackPattern(node: SyntaxNode): boolean {
        // Verifica se há funções passadas como parâmetros
        return node.type === 'call_expression' &&
            node.children?.some(c => c.type === 'function');
    }

    private hasParentConditional(node: SyntaxNode): boolean {
        let current = node;
        while (current.parent) {
            if (this.isDecisionPoint(current.parent)) {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    private extractParameters(node: SyntaxNode): { name: string; type?: string }[] {
        const params: { name: string; type?: string }[] = [];
        const paramList = node.children?.find(child => child.type === 'formal_parameters');

        if (paramList?.children) {
            for (const param of paramList.children) {
                if (param.type === 'required_parameter' || param.type === 'optional_parameter') {
                    const paramName = param.children?.find(c => c.type === 'identifier')?.text;
                    const paramType = param.children?.find(c => c.type === 'type_annotation')?.text;
                    if (paramName) {
                        params.push({ name: paramName, type: paramType });
                    }
                }
            }
        }

        return params;
    }

    private compareParameters(
        params1: { name: string; type?: string }[],
        params2: { name: string; type?: string }[],
    ): number {
        if (params1.length === 0 && params2.length === 0) return 1;
        if (params1.length !== params2.length) return 0;

        let matches = 0;
        for (let i = 0; i < params1.length; i++) {
            const p1 = params1[i];
            const p2 = params2[i];
            if (p1.type === p2.type) matches++;
        }

        return matches / params1.length;
    }

    private extractReturnType(node: SyntaxNode): string | undefined {
        const returnType = node.children?.find(child =>
            child.type === 'return_type_annotation' ||
            child.type === 'type_annotation'
        );
        return returnType?.text;
    }

    private compareStructure(func1: SyntaxNode, func2: SyntaxNode): { changes: string[] } {
        const changes: string[] = [];
        const body1 = this.extractFunctionBody(func1);
        const body2 = this.extractFunctionBody(func2);

        // Compara estrutura básica
        if (this.countControlStructures(body1) !== this.countControlStructures(body2)) {
            changes.push('Diferente número de estruturas de controle');
        }

        // Compara chamadas de função
        const calls1 = this.extractFunctionCalls(body1);
        const calls2 = this.extractFunctionCalls(body2);
        if (!this.areArraysEqual(calls1, calls2)) {
            changes.push('Diferentes chamadas de função');
        }

        // Compara variáveis declaradas
        const vars1 = this.extractVariableDeclarations(body1);
        const vars2 = this.extractVariableDeclarations(body2);
        if (!this.areArraysEqual(vars1, vars2)) {
            changes.push('Diferentes variáveis declaradas');
        }

        // Compara operações
        const ops1 = this.extractOperations(body1);
        const ops2 = this.extractOperations(body2);
        if (!this.areArraysEqual(ops1, ops2)) {
            changes.push('Diferentes operações realizadas');
        }

        return { changes };
    }

    private extractFunctionBody(node: SyntaxNode): SyntaxNode | undefined {
        return node.children?.find(child => child.type === 'statement_block');
    }

    private countControlStructures(node?: SyntaxNode): number {
        if (!node) return 0;
        let count = 0;

        const traverse = (n: SyntaxNode) => {
            if (!n) return;

            if (
                n.type === 'if_statement' ||
                n.type === 'for_statement' ||
                n.type === 'while_statement' ||
                n.type === 'switch_statement'
            ) {
                count++;
            }

            if (Array.isArray(n.children)) {
                n.children.forEach(traverse);
            }
        };

        traverse(node);
        return count;
    }

    private extractFunctionCalls(node?: SyntaxNode): string[] {
        const calls: string[] = [];
        if (!node) return calls;

        const traverse = (n: SyntaxNode) => {
            if (!n) return;

            if (n.type === 'call_expression') {
                const funcName = n.children?.[0]?.text;
                if (funcName) calls.push(funcName);
            }

            if (Array.isArray(n.children)) {
                n.children.forEach(traverse);
            }
        };

        traverse(node);
        return calls.sort();
    }

    private extractVariableDeclarations(node?: SyntaxNode): string[] {
        const vars: string[] = [];
        if (!node) return vars;

        const traverse = (n: SyntaxNode) => {
            if (!n) return;

            if (n.type === 'variable_declarator') {
                const varName = n.children?.[0]?.text;
                if (varName) vars.push(varName);
            }

            if (Array.isArray(n.children)) {
                n.children.forEach(traverse);
            }
        };

        traverse(node);
        return vars.sort();
    }

    private extractOperations(node?: SyntaxNode): string[] {
        const ops: string[] = [];
        if (!node) return ops;

        const traverse = (n: SyntaxNode) => {
            if (!n) return;

            if (
                n.type === 'binary_expression' ||
                n.type === 'unary_expression' ||
                n.type === 'assignment_expression'
            ) {
                ops.push(n.type);
            }

            if (Array.isArray(n.children)) {
                n.children.forEach(traverse);
            }
        };

        traverse(node);
        return ops.sort();
    }

    private areArraysEqual(arr1: string[], arr2: string[]): boolean {
        if (arr1.length !== arr2.length) return false;
        return arr1.every((item, index) => item === arr2[index]);
    }
}
