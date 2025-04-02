import { Inject, Injectable } from '@nestjs/common';
import * as fg from 'fast-glob';
import { Query, SyntaxNode, QueryCapture, QueryMatch } from 'tree-sitter';
import * as fs from 'fs';
import * as os from 'os';
import * as TypeScript from 'tree-sitter-typescript/typescript';
import { IImportPathResolver } from '../contracts/ImportPathResolver';
import { ResolverFactory } from '../resolvers/ResolverFactory';
import {
    Call,
    CodeGraph,
    FileAnalysis,
    FunctionAnalysis,
    TypeAnalysis,
} from '../contracts/CodeGraph';

import {
    SUPPORTED_LANGUAGES,
} from '@/core/domain/codeBase/contracts/SupportedLanguages';
import { TreeSitterService } from './tree-sitter.service';
import {
    normalizeAST,
    normalizeSignature,
} from '@/shared/utils/codeBase/ast-helpers';

@Injectable()
export class CodeKnowledgeGraphService {
    // Cache para resolução de imports
    private importCache: Map<string, any> = new Map();

    constructor(
        @Inject('IImportPathResolver')
        private readonly importPathResolver: IImportPathResolver,
        private readonly resolverFactory: ResolverFactory,
        private readonly treeSitterService: TreeSitterService,
    ) {}

    private async getAllSourceFiles(baseDir: string): Promise<string[]> {
        const allExtensions = Object.values(SUPPORTED_LANGUAGES)
            .flatMap((lang) => lang.extensions)
            .map((ext) => `**/*${ext}`);

        const ignoreDirs = [
            '**/{node_modules,dist,build,coverage,.git,.vscode}/**',
        ];

        const files = await fg(allExtensions, {
            cwd: baseDir,
            absolute: true,
            ignore: ignoreDirs,
            concurrency: os.cpus().length,
        });

        return files;
    }

    /**
     * Constrói o grafo de conhecimento progressivamente, reportando o progresso.
     * Esta abordagem é mais eficiente para repositórios grandes e permite
     * acompanhar o progresso da análise.
     *
     * @param rootDir Diretório raiz do repositório
     * @param onProgress Callback para reportar progresso (opcional)
     * @returns Grafo de conhecimento completo
     */
    public async buildGraphProgressively(
        rootDir: string,
        onProgress?: (processed: number, total: number) => void,
    ): Promise<CodeGraph> {
        // Validar se o diretório existe e não está vazio
        if (!rootDir || rootDir.trim() === '') {
            throw new Error(`Diretório raiz não pode ser vazio ${rootDir}`);
        }

        // Verificar se o diretório existe
        try {
            await fs.promises.access(rootDir, fs.constants.F_OK);
        } catch (error) {
            throw new Error(`Diretório raiz não encontrado: ${rootDir}`);
        }

        console.time('buildGraphProgressively');
        await this.initializeImportResolver(rootDir);

        const result: CodeGraph = {
            files: new Map<string, FileAnalysis>(),
            functions: new Map<string, FunctionAnalysis>(),
            types: new Map<string, TypeAnalysis>(),
        };

        const sourceFiles = await this.getAllSourceFiles(rootDir);

        const filterCriteria = [
            // 'get-reactions.use-case.ts',
            // 'save-feedback.use-case.ts',
            // 'codeReviewFeedback.controller.ts',
            // 'index.type.ts',
            // 'runCodeReview.use-case.ts',
            // 'codeManagement.service.ts',
            'integration-config.service.contracts.ts',
            'integration-config.repository.contracts.ts',
            'integrationConfig.service.ts',
        ];
        const filteredFiles = sourceFiles.filter((file) =>
            filterCriteria.some((keyword) => file.includes(keyword)),
        );

        const totalFiles = sourceFiles.length;

        // Otimização: Calcular tamanho de lote baseado em número de CPUs e memória disponível
        // Usar um lote menor para evitar sobrecarga de memória
        const cpuCount = os.cpus().length;
        const batchSize = Math.max(5, Math.min(cpuCount * 3, 30)); // Aumentando o lote para melhor performance
        let processedCount = 0;

        // Análise com suporte a cancelamento e limitação de recursos
        const processBatches = async () => {
            // Implementar uma fila de processamento
            for (let i = 0; i < totalFiles; i += batchSize) {
                const batchFiles = sourceFiles.slice(
                    i,
                    Math.min(i + batchSize, totalFiles),
                );

                // Processamento paralelo otimizado com Promise.allSettled para processar todos os arquivos mesmo com falhas
                const batchResults = await Promise.allSettled(
                    batchFiles.map(async (filePath) => {
                        const normalizedPath =
                            this.importPathResolver.getNormalizedPath(filePath);
                        try {
                            // Processar arquivo com timeout
                            const timeoutPromise = new Promise<never>(
                                (_, reject) => {
                                    setTimeout(() => {
                                        reject(
                                            new Error(
                                                `Timeout ao processar arquivo ${filePath}`,
                                            ),
                                        );
                                    }, 60000); // 60 segundos timeout
                                },
                            );

                            // Corrida entre análise do arquivo e timeout
                            const analysis = await Promise.race([
                                this.analyzeSourceFile(
                                    filePath,
                                    normalizedPath,
                                ),
                                timeoutPromise,
                            ]);

                            // Converter resultados em Maps se vierem como objetos
                            const functionsMap =
                                analysis.functions instanceof Map
                                    ? analysis.functions
                                    : this.objectToMap(analysis.functions);

                            const typesMap =
                                analysis.types instanceof Map
                                    ? analysis.types
                                    : this.objectToMap(analysis.types);

                            return {
                                filePath,
                                normalizedPath,
                                analysis: {
                                    fileAnalysis: analysis.fileAnalysis,
                                    functions: functionsMap,
                                    types: typesMap,
                                },
                            };
                        } catch (error) {
                            // Registrar erro e continuar com próximo arquivo
                            console.error(
                                `Erro ao analisar arquivo ${filePath}:`,
                                error,
                            );
                            throw error; // Re-lançar o erro para que Promise.allSettled possa capturá-lo corretamente
                        }
                    }),
                );

                // Processar resultados do lote usando os métodos fulfilled/rejected do allSettled
                for (const resultItem of batchResults) {
                    if (resultItem.status === 'fulfilled') {
                        const item = resultItem.value;
                        // Mesclar fileAnalysis
                        result.files.set(
                            item.normalizedPath,
                            item.analysis.fileAnalysis,
                        );

                        // Mesclar functions de forma otimizada
                        if (item.analysis.functions) {
                            for (const [k, v] of (
                                item.analysis.functions as Map<
                                    string,
                                    FunctionAnalysis
                                >
                            ).entries()) {
                                result.functions.set(k, v);
                            }
                        }

                        // Mesclar types de forma otimizada
                        if (item.analysis.types) {
                            for (const [k, v] of (
                                item.analysis.types as Map<string, TypeAnalysis>
                            ).entries()) {
                                result.types.set(k, v);
                            }
                        }
                    } else {
                        // Arquivo falhou, mas nós continuamos o processamento
                        console.warn(
                            `Falha ao processar um arquivo: ${resultItem.reason}`,
                        );
                    }
                }

                // Atualizar progresso
                processedCount += batchFiles.length;
                if (onProgress) {
                    onProgress(processedCount, totalFiles);
                }

                // Liberar memória periodicamente
                if (global.gc && i % (batchSize * 5) === 0) {
                    global.gc();
                }
            }
        };

        await processBatches();

        // Completar relações bidirecionais
        this.completeBidirectionalTypeRelations(result.types);

        console.timeEnd('buildGraphProgressively');
        return result;
    }

    /**
     * Prepara o grafo para serialização JSON convertendo Maps para objetos.
     *
     * @param graph Grafo de conhecimento
     * @returns Grafo serializado
     */
    prepareGraphForSerialization(graph: CodeGraph): any {
        const serialized = {
            files: {},
            functions: {},
            types: {},
        };

        // Converter Map de files para objeto
        for (const [key, value] of graph.files.entries()) {
            serialized.files[key] = value;
        }

        // Converter Map de functions para objeto
        for (const [key, value] of graph.functions.entries()) {
            serialized.functions[key] = value;
        }

        // Converter Map de types para objeto
        for (const [key, value] of graph.types.entries()) {
            serialized.types[key] = value;
        }

        return serialized;
    }

    /**
     * Converte um grafo serializado de volta para o formato com Maps.
     *
     * @param serialized Grafo serializado
     * @returns Grafo de conhecimento
     */
    private deserializeGraph(serialized: any): CodeGraph {
        const graph: CodeGraph = {
            files: new Map(),
            functions: new Map(),
            types: new Map(),
        };

        // Converter objeto de files para Map
        if (serialized.files) {
            for (const [key, value] of Object.entries(serialized.files)) {
                graph.files.set(key, value as FileAnalysis);
            }
        }

        // Converter objeto de functions para Map
        if (serialized.functions) {
            for (const [key, value] of Object.entries(serialized.functions)) {
                graph.functions.set(key, value as FunctionAnalysis);
            }
        }

        // Converter objeto de types para Map
        if (serialized.types) {
            for (const [key, value] of Object.entries(serialized.types)) {
                graph.types.set(key, value as TypeAnalysis);
            }
        }

        return graph;
    }

    /**
     * Inicializa o resolver de imports para o diretório raiz.
     */
    private async initializeImportResolver(rootDir: string): Promise<void> {
        const resolver = await this.resolverFactory.getResolver(rootDir);
        this.importPathResolver.initialize(rootDir, resolver);
    }

    /**
     * Completa a relação bidirecional de tipos (interfaces e classes que implementam).
     */
    private completeBidirectionalTypeRelations(
        types: Map<string, TypeAnalysis>,
    ): void {
        Array.from(types.entries()).forEach(([typeName, typeInfo]) => {
            if (typeInfo.implements) {
                typeInfo.implements.forEach((interfaceName) => {
                    const interfaceType = types.get(interfaceName);
                    if (interfaceType) {
                        if (!interfaceType.implementedBy) {
                            interfaceType.implementedBy = [];
                        }
                        if (!interfaceType.implementedBy.includes(typeName)) {
                            interfaceType.implementedBy.push(typeName);
                        }
                        types.set(interfaceName, interfaceType);
                    }
                });
            }

            if (typeInfo.extends) {
                typeInfo.extends.forEach((parentName) => {
                    const parentType = types.get(parentName);
                    if (parentType) {
                        if (!parentType.extendedBy) {
                            parentType.extendedBy = [];
                        }
                        if (!parentType.extendedBy.includes(typeName)) {
                            parentType.extendedBy.push(typeName);
                        }
                        types.set(parentName, parentType);
                    }
                });
            }
        });
    }

    private async readFileContent(filePath: string): Promise<string | null> {
        try {
            await fs.promises.access(filePath, fs.constants.R_OK);

            return await fs.promises.readFile(filePath, 'utf-8');
        } catch (error) {
            return null;
        }
    }

    private collectTypeDetailsUsingQuery(
        rootNode: SyntaxNode,
        absolutePath: string,
        types: Map<string, TypeAnalysis>,
        importedMapping: Map<string, string>,
    ): void {
        // Manter o caminho original para as chaves, mas ainda precisamos do lowercase para compatibilidade com outras partes do código
        const pathLower = absolutePath.toLowerCase();

        // Uma única query para capturar interface, type alias, enum, class
        const querystring = `
          ;; Interface
          (interface_declaration
            name: (type_identifier) @ifaceName
            body: (object_type)? @ifaceBody
            (extends_clause)? @ifaceExt
          ) @ifaceDecl

          ;; Class
          (class_declaration
            name: (type_identifier) @className
            (class_heritage)? @classHeritage
            body: (class_body)? @classBody
          ) @classDecl

          ;; Type alias (type X = ...)
          (type_alias_declaration
            name: (type_identifier) @typeName
            "="
            (_) @aliasType
          ) @typeAliasDecl

          ;; Enum
          (enum_declaration
            name: (identifier) @enumName
            body: (enum_body)? @enumBody
          ) @enumDecl
        `;

        const query = new Query(TypeScript, querystring);
        const matches = query.matches(rootNode);

        // Processa cada match capturado pela query
        for (const match of matches) {
            this.processTypeMatch(
                match,
                pathLower,
                absolutePath,
                types,
                importedMapping,
            );
        }
    }

    /**
     * processTypeMatch: recebe um QueryMatch e decide se é interface, type alias, enum ou class
     * e chama a lógica de parse apropriada.
     */
    private processTypeMatch(
        match: QueryMatch,
        pathLower: string,
        absolutePath: string,
        types: Map<string, TypeAnalysis>,
        importedMapping: Map<string, string>,
    ) {
        const captures = match.captures.reduce(
            (acc, capture) => {
                acc[capture.name] = capture;
                return acc;
            },
            {} as Record<string, QueryCapture>,
        );

        const {
            ifaceDecl,
            ifaceName,
            ifaceBody,
            ifaceExt,
            classDecl,
            className,
            classHeritage,
            classBody,
            typeAliasDecl,
            typeName,
            aliasType,
            enumDecl,
            enumName,
            enumBody,
        } = captures;

        // 1) Interface
        if (ifaceDecl) {
            const nameNode = ifaceName?.node;
            const extendsNode = ifaceExt?.node;
            const bodyNode = ifaceBody?.node;

            if (nameNode) {
                const interfaceName = nameNode.text;
                const key = `${absolutePath}:${interfaceName}`;

                let ifaceObj = types.get(key) || {
                    file: pathLower,
                    type: 'interface',
                    name: interfaceName,
                    fields: {},
                };

                if (extendsNode) {
                    const extended = this.collectInterfaceExtends(
                        extendsNode,
                        pathLower,
                        absolutePath,
                        importedMapping,
                    );
                    if (extended.length > 0) {
                        const existingExtends = new Set(ifaceObj.extends || []);
                        extended.forEach((ext) => existingExtends.add(ext));
                        ifaceObj.extends = [...existingExtends];
                    }
                }

                if (bodyNode && bodyNode.type === 'object_type') {
                    const fields = this.parseObjectType(bodyNode);
                    ifaceObj.fields = { ...ifaceObj.fields, ...fields };
                }

                types.set(key, ifaceObj);
            }
        }

        // 2) Class
        if (classDecl) {
            const nameNode = className?.node;
            const heritageNode = classHeritage?.node;
            if (nameNode) {
                const classNameStr = nameNode.text;
                const key = `${absolutePath}:${classNameStr}`;

                let classObj = types.get(key) || {
                    file: pathLower,
                    type: 'class',
                    name: classNameStr,
                    fields: {},
                };

                if (heritageNode) {
                    const { extendedClass, implemented } =
                        this.collectClassHeritage(
                            heritageNode,
                            pathLower,
                            absolutePath,
                            importedMapping,
                        );

                    if (extendedClass) {
                        const existingExtends = new Set(classObj.extends || []);
                        existingExtends.add(extendedClass);
                        classObj.extends = [...existingExtends];
                    }

                    if (implemented.length > 0) {
                        const existingImpl = new Set(classObj.implements || []);
                        implemented.forEach((impl) => existingImpl.add(impl));
                        classObj.implements = [...existingImpl];
                    }
                }

                types.set(key, classObj);
            }
        }

        // 3) Type alias
        if (typeAliasDecl) {
            const nameNode = typeName?.node;
            const aliasNode = aliasType?.node;

            if (nameNode) {
                const typeNameStr = nameNode.text;
                const key = `${absolutePath}:${typeNameStr}`;

                let typeObj = types.get(key) || {
                    file: pathLower,
                    type: 'type',
                    name: typeNameStr,
                    fields: {},
                };

                if (aliasNode) {
                    switch (aliasNode.type) {
                        case 'object_type':
                            const fields = this.parseObjectType(aliasNode);
                            typeObj.fields = { ...typeObj.fields, ...fields };
                            break;
                        case 'union_type':
                            const unionMembers: Record<string, string> = {};
                            for (
                                let i = 0;
                                i < aliasNode.namedChildCount;
                                i++
                            ) {
                                const child = aliasNode.namedChild(i);
                                if (child) unionMembers[child.text] = '';
                            }
                            typeObj.fields = {
                                ...typeObj.fields,
                                ...unionMembers,
                            };
                            break;
                        default:
                            typeObj.fields = {
                                ...typeObj.fields,
                                raw: aliasNode.text,
                            };
                    }
                }

                types.set(key, typeObj);
            }
        }

        // 4) Enum
        if (enumDecl) {
            const nameNode = enumName?.node;
            const bodyNode = enumBody?.node;

            if (nameNode) {
                const enumNameStr = nameNode.text;
                const key = `${absolutePath}:${enumNameStr}`;

                let enumObj = types.get(key) || {
                    file: pathLower,
                    type: 'enum',
                    name: enumNameStr,
                    fields: {},
                };

                if (bodyNode && bodyNode.type === 'enum_body') {
                    const newFields: Record<string, string> = {};
                    for (let i = 0; i < bodyNode.namedChildCount; i++) {
                        const member = bodyNode.namedChild(i);
                        if (!member) continue;

                        if (
                            member.type === 'enum_assignment' ||
                            member.type === 'enum_member'
                        ) {
                            const keyNode =
                                member.childForFieldName('name') ||
                                member.firstChild;
                            const valueNode = member.childForFieldName('value');
                            if (keyNode) {
                                const key = keyNode.text;
                                const value = valueNode
                                    ? valueNode.text.trim()
                                    : '';
                                newFields[key] = value;
                            }
                        }
                    }
                    enumObj.fields = { ...enumObj.fields, ...newFields };
                }

                types.set(key, enumObj);
            }
        }
    }

    /**
     * parseObjectType: lê um nó do tipo 'object_type' (usado em interface ou type = { ... })
     * e extrai as assinaturas de propriedades (property_signature) e métodos (method_signature).
     */
    private parseObjectType(
        objectTypeNode: SyntaxNode,
    ): Record<string, string> {
        const fields: Record<string, string> = {};
        objectTypeNode.namedChildren.forEach((child) => {
            if (child.type === 'property_signature') {
                const propNameNode = child.childForFieldName('name');
                const propTypeNode = child.childForFieldName('type');
                if (propNameNode) {
                    const propType = propTypeNode
                        ? this.normalizeSignatureText(
                              propTypeNode.text.replace(/^:/, ''),
                          )
                        : 'any';
                    fields[propNameNode.text] = propType;
                }
            } else if (child.type === 'method_signature') {
                const methodNameNode = child.childForFieldName('name');
                const paramsNode = child.childForFieldName('parameters');
                const returnTypeNode = child.childForFieldName('return_type');
                if (methodNameNode) {
                    const paramsText = paramsNode
                        ? this.normalizeSignatureText(paramsNode.text)
                        : '()';
                    const returnText = returnTypeNode
                        ? this.normalizeSignatureText(
                              returnTypeNode.text.replace(/^:/, ''),
                          )
                        : 'void';
                    fields[methodNameNode.text] = `${paramsText}:${returnText}`;
                }
            }
        });
        return fields;
    }

    /**
     * collectInterfaceExtends: lê o extends_clause e extrai cada interface estendida.
     */
    private collectInterfaceExtends(
        extendsNode: SyntaxNode,
        pathLower: string,
        absolutePath: string,
        importedMapping: Map<string, string>,
    ): string[] {
        const extendedIfaces: string[] = [];
        extendsNode.namedChildren.forEach((extNode) => {
            if (extNode.type === 'type_identifier') {
                const rawName = extNode.text;
                const mapped = importedMapping.get(rawName.toLowerCase());
                if (mapped) {
                    extendedIfaces.push(`${mapped}:${rawName}`);
                } else {
                    extendedIfaces.push(`${absolutePath}:${rawName}`);
                }
            } else if (extNode.type === 'generic_type') {
                // ex: extends Something<XYZ>
                const baseNameNode = extNode.childForFieldName('name');
                if (baseNameNode) {
                    const rawName = baseNameNode.text;
                    const mapped = importedMapping.get(rawName.toLowerCase());
                    if (mapped) {
                        extendedIfaces.push(`${mapped}:${rawName}`);
                    } else {
                        extendedIfaces.push(`${absolutePath}:${rawName}`);
                    }
                }
            }
            // Você pode adicionar outras checagens (type_reference, qualified_type_identifier, etc.)
        });
        return extendedIfaces;
    }

    /**
     * collectClassHeritage: lê o class_heritage (que pode conter extends_clause e implements_clause)
     * e retorna extendedClass e uma lista de implemented interfaces.
     */
    private collectClassHeritage(
        heritageNode: SyntaxNode,
        pathLower: string,
        absolutePath: string,
        importedMapping: Map<string, string>,
    ): { extendedClass: string | null; implemented: string[] } {
        let extendedClass: string | null = null;
        const implemented: string[] = [];

        heritageNode.namedChildren.forEach((child) => {
            if (child.type === 'extends_clause') {
                child.namedChildren.forEach((typeNode) => {
                    if (typeNode.type === 'type_identifier') {
                        extendedClass = typeNode.text;
                    } else if (typeNode.type === 'generic_type') {
                        const baseNameNode = typeNode.childForFieldName('name');
                        if (baseNameNode) {
                            extendedClass = baseNameNode.text;
                        }
                    }
                });
            } else if (child.type === 'implements_clause') {
                child.namedChildren.forEach((typeNode) => {
                    if (typeNode.type === 'type_identifier') {
                        const rawIfaceName = typeNode.text;
                        const mapped = importedMapping.get(
                            rawIfaceName.toLowerCase(),
                        );
                        if (mapped) {
                            implemented.push(`${mapped}:${rawIfaceName}`);
                        } else {
                            // fallback: local
                            implemented.push(`${absolutePath}:${rawIfaceName}`);
                        }
                    } else if (typeNode.type === 'generic_type') {
                        const baseNameNode = typeNode.childForFieldName('name');
                        if (baseNameNode) {
                            const rawIfaceName = baseNameNode.text;
                            const mapped = importedMapping.get(
                                rawIfaceName.toLowerCase(),
                            );
                            if (mapped) {
                                implemented.push(`${mapped}:${rawIfaceName}`);
                            } else {
                                implemented.push(
                                    `${absolutePath}:${rawIfaceName}`,
                                );
                            }
                        }
                    }
                });
            }
        });

        return { extendedClass, implemented };
    }

    private normalizeSignatureText(original: string): string {
        // Remove quebras de linha, múltiplos espaços, etc.
        return original.replace(/\s+/g, ' ').trim();
    }

    /**
     * Converte um objeto para Map
     * @param obj Objeto a ser convertido
     * @returns Map equivalente ao objeto
     */
    private objectToMap<T>(obj: Record<string, T>): Map<string, T> {
        const map = new Map<string, T>();
        if (obj && typeof obj === 'object') {
            Object.entries(obj).forEach(([key, value]) => {
                map.set(key, value);
            });
        }
        return map;
    }

    private async collectAllInOnePass(
        rootNode: SyntaxNode,
        filePath: string,
        absolutePath: string,
        context: {
            fileDefines: Set<string>;
            fileImports: Set<string>;
            fileClassNames: Set<string>;
            fileCalls: Call[];
            importedMapping: Map<string, string>;
            instanceMapping: Map<string, string>;
            types: Map<string, TypeAnalysis>;
            functions: Map<string, FunctionAnalysis>;
        },
    ): Promise<void> {
        // 1) Cria uma query que captura imports, definições e calls
        const queryString = `
          ;; Captura imports
          (import_statement) @import

          ;; Captura declarações de classe, interface, enum, type, function, method
          (class_declaration
            name: (type_identifier) @name.definition.class
          ) @definition.class

          (interface_declaration
            name: (type_identifier) @name.definition.interface
          ) @definition.interface

          (enum_declaration
            name: (identifier) @name.definition.enum
          ) @definition.enum

          (type_alias_declaration
            name: (type_identifier) @name.definition.type
          ) @definition.type

          (function_declaration
            name: (identifier) @name.definition.function
          ) @definition.function

          (method_definition
            name: (property_identifier) @name.definition.method
          ) @definition.method

          (function_signature
            name: (identifier) @name.definition.function
          ) @definition.function

          (method_signature
            name: (property_identifier) @name.definition.method
          ) @definition.method

          (abstract_method_signature
            name: (property_identifier) @name.definition.method
          ) @definition.method

          ;; Captura call_expressions do tipo "this.instance.method(...)"
          (
            call_expression
              function: (member_expression
                object: (member_expression
                  object: (this) @this
                  property: (property_identifier) @instance
                )
                property: (property_identifier) @method
              )
              arguments: (_)
          ) @buildCall
        `;

        const query = new Query(TypeScript, queryString);
        const matches = query.matches(rootNode);

        // 2) Separamos as capturas em arrays distintos, para impor a ordem de processamento
        const importNodes: SyntaxNode[] = [];
        const definitionMatches: Array<{
            match: QueryMatch;
            captureName: string;
        }> = [];
        const callMatches: Array<{
            match: QueryMatch;
            buildCallCapture: QueryCapture;
        }> = [];

        for (const match of matches) {
            const importCapture = match.captures.find(
                (c) => c.name === 'import',
            );
            const buildCallCapture = match.captures.find(
                (c) => c.name === 'buildCall',
            );

            const defClassCapture = match.captures.find(
                (c) => c.name === 'definition.class',
            );
            const defInterfaceCapture = match.captures.find(
                (c) => c.name === 'definition.interface',
            );
            const defEnumCapture = match.captures.find(
                (c) => c.name === 'definition.enum',
            );
            const defTypeCapture = match.captures.find(
                (c) => c.name === 'definition.type',
            );
            const defFunctionCapture = match.captures.find(
                (c) => c.name === 'definition.function',
            );
            const defMethodCapture = match.captures.find(
                (c) => c.name === 'definition.method',
            );

            // IMPORT
            if (importCapture) {
                importNodes.push(importCapture.node);
            }

            // DEFINIÇÕES (classe, etc.)
            if (defClassCapture) {
                definitionMatches.push({
                    match,
                    captureName: 'definition.class',
                });
            }
            if (defInterfaceCapture) {
                definitionMatches.push({
                    match,
                    captureName: 'definition.interface',
                });
            }
            if (defEnumCapture) {
                definitionMatches.push({
                    match,
                    captureName: 'definition.enum',
                });
            }
            if (defTypeCapture) {
                definitionMatches.push({
                    match,
                    captureName: 'definition.type',
                });
            }
            if (defFunctionCapture) {
                definitionMatches.push({
                    match,
                    captureName: 'definition.function',
                });
            }
            if (defMethodCapture) {
                definitionMatches.push({
                    match,
                    captureName: 'definition.method',
                });
            }

            // CALL
            if (buildCallCapture) {
                callMatches.push({ match, buildCallCapture });
            }
        }

        // 3) Primeiro processamos todos os imports
        //    -> garante que importedMapping esteja preenchido
        for (const importNode of importNodes) {
            await this.processImportStatement(importNode, filePath, {
                fileImports: context.fileImports,
                importedMapping: context.importedMapping,
            });
        }

        // 4) Depois processamos as definições (classes, interfaces, etc.)
        //    -> aqui já podemos usar importedMapping (por exemplo, para extends/implements)
        const tasks: Promise<void>[] = [];
        for (const { match, captureName } of definitionMatches) {
            const captured = match.captures.find((c) => c.name === captureName);
            if (!captured) continue; // segurança

            switch (captureName) {
                case 'definition.class': {
                    // Adiciona o nome no fileClassNames
                    const nameNode = captured.node.childForFieldName('name');
                    if (nameNode) {
                        context.fileClassNames.add(nameNode.text);
                    }
                    tasks.push(
                        this.processClassDeclaration(
                            captured.node,
                            absolutePath,
                            context.fileClassNames,
                            context.instanceMapping,
                            context.types,
                            context.importedMapping,
                            context.functions,
                        ),
                    );
                    break;
                }

                case 'definition.interface': {
                    const nameNode = captured.node.childForFieldName('name');
                    if (nameNode) {
                        context.fileClassNames.add(nameNode.text);
                    }
                    // Exemplo parse de métodos da interface
                    const bodyNode =
                        captured.node.childForFieldName('body') ||
                        captured.node.namedChildren.find(
                            (c) => c.type === 'object_type',
                        );

                    if (bodyNode) {
                        for (const member of bodyNode.namedChildren) {
                            if (member.type === 'method_signature') {
                                const methodNameNode =
                                    member.childForFieldName('name');
                                if (methodNameNode) {
                                    context.fileDefines.add(
                                        methodNameNode.text,
                                    );
                                }
                            }
                        }
                    }
                    break;
                }

                case 'definition.enum':
                case 'definition.type':
                case 'definition.function':
                case 'definition.method': {
                    const nameNode = captured.node.childForFieldName('name');
                    context.fileDefines.add(
                        nameNode ? nameNode.text : captured.node.text,
                    );
                    break;
                }

                default:
                    break;
            }
        }

        // Aguarda todas as tasks (classe, etc.) finalizarem
        await Promise.all(tasks);

        // 5) Por fim, processamos as chamadas (buildCall)
        //    -> agora importedMapping e instanceMapping estão populados
        for (const { match, buildCallCapture } of callMatches) {
            // localiza instance e method
            const instanceCapture = match.captures.find(
                (c) => c.name === 'instance',
            );
            const methodCapture = match.captures.find(
                (c) => c.name === 'method',
            );
            if (!instanceCapture || !methodCapture) {
                continue;
            }

            const instanceName = instanceCapture.node.text.toLowerCase();
            const methodName = methodCapture.node.text;

            let calledFile = absolutePath; // fallback: chamada local

            if (context.instanceMapping.get(instanceName)) {
                const typeName = context.instanceMapping.get(instanceName);
                const importedFile = context.importedMapping.get(
                    typeName.toLowerCase(),
                );
                if (importedFile) {
                    calledFile = importedFile;
                }
            }

            if (calledFile !== absolutePath) {
                context.fileCalls.push({
                    function: methodName,
                    file: calledFile,
                    caller: undefined,
                });
            }
        }
    }

    private async analyzeSourceFile(
        filePath: string,
        absolutePath: string,
    ): Promise<{
        fileAnalysis: FileAnalysis;
        functions: Map<string, FunctionAnalysis>;
        types: Map<string, TypeAnalysis>;
    }> {
        // Verificar se o arquivo existe antes de tentar ler
        try {
            // Leitura eficiente com streams para arquivos grandes
            const content = await this.readFileContent(filePath);
            if (!content) {
                return this.emptyAnalysis();
            }

            // Otimização: verificar tamanho do arquivo e pular arquivos muito grandes
            const fileStats = await fs.promises
                .stat(filePath)
                .catch(() => null);
            const fileSizeInMB = fileStats?.size / (1024 * 1024);
            if (fileSizeInMB > 5) {
                // Pular arquivos maiores que 5MB
                console.warn(
                    `Arquivo muito grande para análise (${fileSizeInMB.toFixed(2)}MB): ${filePath}`,
                );
                return this.emptyAnalysis();
            }

            // Obtem a AST do arquivo de forma otimizada
            const syntaxTree = this.treeSitterService.parse(
                content,
                'typescript',
            );

            if (!syntaxTree) {
                return this.emptyAnalysis();
            }

            // Cria um contexto para armazenar os dados coletados
            // Usando Maps e Sets pré-alocados para melhor performance
            const context = {
                fileDefines: new Set<string>(),
                fileImports: new Set<string>(),
                fileClassNames: new Set<string>(),
                functions: new Map<string, FunctionAnalysis>(),
                fileCalls: [] as Call[],
                importedMapping: new Map<string, string>(),
                instanceMapping: new Map<string, string>(),
                types: new Map<string, TypeAnalysis>(),
            };

            // Coletar todas as informações em uma única passagem pela AST
            await this.collectAllInOnePass(
                syntaxTree.rootNode,
                filePath,
                absolutePath,
                context,
            );

            // // Coleta detalhes de funções usando a query (otimizado)
            await this.collectFunctionDetailsWithQuery(
                syntaxTree.rootNode,
                absolutePath,
                context,
            );

            // Coleta detalhes de tipos usando a query (otimizado)
            this.collectTypeDetailsUsingQuery(
                syntaxTree.rootNode,
                absolutePath,
                context.types,
                context.importedMapping,
            );

            // Otimização: Processamento em batch das importações
            // Usar Promise.all para paralelizar as resoluções de importação
            const uniqueImports = Array.from(context.fileImports);
            // Limitar o número de promessas paralelas para evitar sobrecarga
            const batchSize = 10;
            const normalizedImports: string[] = [];

            for (let i = 0; i < uniqueImports.length; i += batchSize) {
                const batch = uniqueImports.slice(i, i + batchSize);
                const batchResults = await Promise.all(
                    batch.map(async (imp) => {
                        try {
                            const resolved = await this.resolveImportWithCache(
                                imp,
                                filePath,
                            );
                            return resolved?.normalizedPath || imp;
                        } catch (err) {
                            // Falha silenciosa para continuar processando o arquivo
                            return imp;
                        }
                    }),
                );
                normalizedImports.push(...batchResults);
            }

            return {
                fileAnalysis: {
                    defines: Array.from(context.fileDefines),
                    calls: context.fileCalls,
                    imports: normalizedImports,
                    className: Array.from(context.fileClassNames),
                },
                functions: context.functions,
                types: context.types,
            };
        } catch (error) {
            console.error(`Erro ao analisar arquivo ${filePath}:`, error);
            return this.emptyAnalysis();
        }
    }

    /**
     * Resolve um import com cache para evitar resoluções repetidas.
     */
    private async resolveImportWithCache(
        importPath: string,
        filePath: string,
    ): Promise<any> {
        const cacheKey = `${importPath}:${filePath}`;

        if (this.importCache.has(cacheKey)) {
            return this.importCache.get(cacheKey);
        }

        const resolved = await this.importPathResolver.resolveImport(
            importPath,
            filePath,
        );
        this.importCache.set(cacheKey, resolved);
        return resolved;
    }

    /**
     * Retorna uma análise vazia para quando um arquivo não pode ser processado
     */
    private emptyAnalysis(): {
        fileAnalysis: FileAnalysis;
        functions: Map<string, FunctionAnalysis>;
        types: Map<string, TypeAnalysis>;
    } {
        return {
            fileAnalysis: { defines: [], calls: [], imports: [] },
            functions: new Map(),
            types: new Map(),
        };
    }

    /**
     * Processa uma declaração de importação
     */
    private async processImportStatement(
        node: SyntaxNode,
        filePath: string,
        context: {
            fileImports: Set<string>;
            importedMapping: Map<string, string>;
        },
    ): Promise<void> {
        const tasks: Promise<void>[] = [];

        const stringNode = node.children.find(
            (child) => child.type === 'string',
        );

        if (!stringNode) {
            return;
        }

        const moduleName = stringNode.text.replace(/['"]/g, '');
        const resolvedImport = await this.resolveImportWithCache(
            moduleName,
            filePath,
        );

        const normalizedPath = resolvedImport?.normalizedPath || moduleName;
        context.fileImports.add(normalizedPath);

        for (const child of node.namedChildren) {
            if (child.type === 'identifier') {
                context.importedMapping.set(
                    child.text.toLowerCase(),
                    normalizedPath,
                );
            } else if (
                ['import_clause', 'named_imports', 'namespace_import'].includes(
                    child.type,
                )
            ) {
                if (child.type === 'named_imports') {
                    const tokens = this.extractTokensFromNode(child);
                    tokens.forEach((token) => {
                        context.importedMapping.set(
                            token.toLowerCase(),
                            normalizedPath,
                        );
                    });
                } else if (
                    child.namedChildren &&
                    child.namedChildren.length > 0
                ) {
                    for (const spec of child.namedChildren) {
                        tasks.push(
                            Promise.resolve(
                                this.processImportSpecifier(
                                    spec,
                                    normalizedPath,
                                    context.importedMapping,
                                ),
                            ),
                        );
                    }
                } else {
                    const tokens = this.extractTokensFromNode(child);
                    tokens.forEach((token) => {
                        context.importedMapping.set(
                            token.toLowerCase(),
                            normalizedPath,
                        );
                    });
                }
            }
        }

        await Promise.all(tasks);
    }

    /**
     * Processa um especificador de importação
     */
    private processImportSpecifier(
        spec: any,
        modulePath: string,
        importedMapping: Map<string, string>,
    ): void {
        const addMapping = (alias: string | undefined) => {
            if (alias) {
                importedMapping.set(alias.toLowerCase(), modulePath);
            }
        };

        switch (spec.type) {
            case 'import_specifier':
            case 'namespace_import': {
                const nameNode = spec.childForFieldName('name') || spec;
                const aliasNode = spec.childForFieldName('alias');
                let alias = aliasNode ? aliasNode.text : nameNode.text;

                if (!alias && spec.text) {
                    alias = spec.text;
                }

                if (alias) {
                    addMapping(alias);
                }

                break;
            }
            case 'identifier': {
                addMapping(spec.text);
                break;
            }
            case 'named_imports': {
                const tokens = this.extractTokensFromNode(spec);

                tokens.forEach((token) => addMapping(token));
                break;
            }
            default:
                console.warn(`Tipo de spec não tratado: ${spec.type}`);
        }
    }

    /**
     * Extrai tokens de um nó
     */
    private extractTokensFromNode(node: any): string[] {
        return node.text.match(/\b[\w$]+\b/g) || [];
    }

    /**
     * Processa uma declaração de classe
     */
    private async processClassDeclaration(
        node: SyntaxNode,
        absolutePath: string,
        fileClassNames: Set<string>,
        instanceMapping: Map<string, string>,
        types: Map<string, TypeAnalysis>,
        importedMapping: Map<string, string>,
        functions: Map<string, FunctionAnalysis>,
    ): Promise<void> {
        const nameNode = node.childForFieldName('name');

        if (!nameNode) {
            return;
        }

        const className = nameNode.text;
        fileClassNames.add(className);

        const key = `${absolutePath}:${className}`;

        // Otimização: usar operador de coalescência nula para simplificar
        let classAnalysis = types.get(key) || {
            file: absolutePath,
            type: 'class',
            name: className,
            fields: {},
        };

        // Atualizar campos base
        classAnalysis.file = absolutePath;
        classAnalysis.name = className;

        const heritageClause = node.namedChildren.find(
            (child) => child.type === 'class_heritage',
        );
        if (heritageClause) {
            const implementedKeys: string[] = [];
            let extendedClass: string | undefined;

            heritageClause.namedChildren.forEach((clauseNode) => {
                if (clauseNode.type === 'extends_clause') {
                    clauseNode.namedChildren.forEach((typeNode) => {
                        if (typeNode.type === 'type_identifier') {
                            extendedClass = typeNode.text;
                        } else if (typeNode.type === 'generic_type') {
                            const baseNameNode =
                                typeNode.childForFieldName('name');
                            if (baseNameNode) {
                                extendedClass = baseNameNode.text;
                            }
                        }
                    });
                }
                if (clauseNode.type === 'implements_clause') {
                    clauseNode.namedChildren.forEach((typeNode) => {
                        if (typeNode.type === 'type_identifier') {
                            const rawIfaceName = typeNode.text;
                            const mapped = importedMapping.get(
                                rawIfaceName.toLowerCase(),
                            );
                            if (mapped) {
                                implementedKeys.push(
                                    `${mapped}:${rawIfaceName}`,
                                );
                            } else {
                                // fallback: local
                                implementedKeys.push(
                                    `${absolutePath}:${rawIfaceName}`,
                                );
                            }
                        } else if (typeNode.type === 'generic_type') {
                            const baseNameNode =
                                typeNode.childForFieldName('name');
                            if (baseNameNode) {
                                const rawIfaceName = baseNameNode.text;
                                const mapped = importedMapping.get(
                                    rawIfaceName.toLowerCase(),
                                );
                                if (mapped) {
                                    implementedKeys.push(
                                        `${mapped}:${rawIfaceName}`,
                                    );
                                } else {
                                    implementedKeys.push(
                                        `${absolutePath}:${rawIfaceName}`,
                                    );
                                }
                            }
                        }
                    });
                }
            });

            if (extendedClass) {
                const existingExtends = new Set(classAnalysis.extends || []);
                existingExtends.add(extendedClass);
                classAnalysis.extends = Array.from(existingExtends);
            }

            if (implementedKeys?.length > 0) {
                const existingImpl = new Set(classAnalysis.implements || []);
                implementedKeys.forEach((key) => existingImpl.add(key));
                classAnalysis.implements = Array.from(existingImpl);
            }
        }

        // Verifica construtor
        const classBody =
            node.childForFieldName('body') ||
            node.namedChildren.find((n) => n.type === 'class_body');
        if (classBody) {
            classBody.namedChildren.forEach((child) => {
                if (
                    child.type === 'constructor' ||
                    (child.type === 'method_definition' &&
                        child.childForFieldName('name')?.text === 'constructor')
                ) {
                    this.processConstructor(child, instanceMapping);
                }
            });
        }

        types.set(key, classAnalysis);
    }

    /**
     * Processa um construtor
     */
    private processConstructor(
        node: SyntaxNode,
        instanceMapping: Map<string, string>,
    ): void {
        const paramsNode = node.childForFieldName('parameters');

        if (!paramsNode) {
            return;
        }

        paramsNode.namedChildren.forEach((param) => {
            const paramName = this.extractParamName(param);
            const typeNode = param.childForFieldName('type');
            if (paramName && typeNode) {
                const typeText = typeNode.text
                    .replace(/^:/, '')
                    .trim()
                    .toLowerCase();
                // Mantemos a lógica original:
                instanceMapping.set(paramName.toLowerCase(), typeText);
                instanceMapping.set(typeText, typeText);
            }
        });
    }

    /**
     * Extrai o nome de um parâmetro
     */
    private extractParamName(param: any): string | null {
        const modifiers = new Set([
            'private',
            'public',
            'protected',
            'readonly',
        ]);

        for (let i = 0; i < param.childCount; i++) {
            const child = param.child(i);
            if (
                child.type === 'identifier' &&
                !modifiers.has(child.text.toLowerCase())
            ) {
                return child.text;
            }
        }
        return null;
    }

    /**
     * Extrai a cadeia de membros de um nó (por exemplo, this.getReactionsUseCase.execute)
     */
    private getMemberChain(node: SyntaxNode): string[] {
        const chain: string[] = [];
        let current: SyntaxNode | null = node;
        while (current && current.type === 'member_expression') {
            const prop = current.childForFieldName('property');
            if (prop) {
                chain.unshift(prop.text);
            }
            current = current.childForFieldName('object');
        }
        if (current) {
            chain.unshift(current.text);
        }
        return chain;
    }

    /**
     * Coleta detalhes de funções usando query
     */
    private collectFunctionDetailsWithQuery(
        rootNode: SyntaxNode,
        absolutePath: string,
        context: {
            functions: Map<string, FunctionAnalysis>;
            importedMapping: Map<string, string>;
            instanceMapping: Map<string, string>;
        },
    ): void {
        // Query unificada para capturar diferentes formas de declaração de função/método
        const funcQuery = new Query(
            TypeScript,
            `
      (
        function_declaration
          name: (identifier) @funcName
          parameters: (formal_parameters) @params
          body: (statement_block) @body
      )
      (
        method_definition
          name: (property_identifier) @funcName
          parameters: (formal_parameters) @params
          body: (statement_block) @body
      )
      (
        variable_declarator
          name: (identifier) @funcName
          value: (arrow_function
                    parameters: (formal_parameters) @params
                    body: (_) @body)
      )
      `,
        );

        // Query para capturar chamadas dentro do corpo da função
        const callQuery = new Query(
            TypeScript,
            `
      (
        call_expression
          function: (identifier) @callName
      )
      (
        call_expression
          function: (member_expression
                      property: (property_identifier) @callName)
      )
      `,
        );

        const funcCaptures = funcQuery.captures(rootNode);

        // Processa cada declaração de função encontrada
        for (const { node, name } of funcCaptures) {
            const funcDeclNode = node.parent;

            if (name !== 'funcName') {
                continue;
            }

            if (!funcDeclNode) {
                continue;
            }

            // Extrai parâmetros e tipo de retorno (se disponível)
            const paramsNode = funcDeclNode.childForFieldName('parameters');
            const returnTypeNode =
                funcDeclNode.childForFieldName('return_type');
            const params = paramsNode
                ? paramsNode.namedChildren.map((p) => p.text)
                : [];
            const funcNameText = node.text;
            const key = `${absolutePath}:${funcNameText}`;
            const bodyNode = funcDeclNode.childForFieldName('body');

            let calledFunctions: Call[] = [];
            let className: string | undefined = undefined;
            let current = funcDeclNode.parent;

            while (current) {
                if (current.type === 'class_declaration') {
                    const classNameNode =
                        current.childForFieldName('name') ||
                        current.namedChildren.find(
                            (child) => child.type === 'identifier',
                        );
                    if (classNameNode) {
                        className = classNameNode.text;
                        break;
                    }
                }
                current = current.parent;
            }

            if (bodyNode) {
                const callCaptures = callQuery.captures(bodyNode);

                calledFunctions = callCaptures.map((capture) => {
                    const callNode = capture.node;
                    let targetFile = absolutePath; // fallback: chamada local

                    if (
                        callNode.parent &&
                        callNode.parent.type === 'member_expression'
                    ) {
                        const chain = this.getMemberChain(callNode.parent);
                        let instanceName: string | undefined;

                        // Se a cadeia for do tipo "this.getX.execute"
                        if (chain.length >= 3 && chain[0] === 'this') {
                            instanceName = chain[1];
                        }
                        // Se for do tipo "getX.execute"
                        else if (chain.length >= 2) {
                            instanceName = chain[0];
                        }
                        // Se houver um identificador na cadeia, mesmo que a cadeia tenha só 1 elemento, pode ser importada
                        else if (chain.length === 1) {
                            instanceName = chain[0];
                        }

                        if (instanceName) {
                            // Primeiro tenta resolver via instanceMapping (usado para propriedades definidas na classe)
                            let typeName = context.instanceMapping.get(
                                instanceName.toLowerCase(),
                            );
                            // Se não encontrar, utiliza o próprio instanceName como fallback
                            if (!typeName) {
                                typeName = instanceName;
                            }
                            // Em seguida, procura no importedMapping o arquivo correspondente
                            const importedFile = context.importedMapping.get(
                                typeName.toLowerCase(),
                            );
                            if (importedFile) {
                                targetFile = importedFile;
                            }
                        }
                    }

                    return {
                        function: callNode.text,
                        file: targetFile,
                        caller: funcNameText,
                    };
                });
            }

            const returnType = returnTypeNode
                ? returnTypeNode.text.replace(/^:/, '').trim()
                : '';

            const normalizedBody = normalizeAST(bodyNode);
            const signatureHash = normalizeSignature(params, returnType);

            context.functions.set(key, {
                file: absolutePath,
                name: funcNameText,
                params,
                lines:
                    funcDeclNode.endPosition.row -
                    funcDeclNode.startPosition.row +
                    1,
                returnType: returnType,
                calls: calledFunctions,
                className,
                startLine: funcDeclNode.startPosition.row + 1,
                endLine: funcDeclNode.endPosition.row + 1,
                functionHash: normalizedBody,
                signatureHash: signatureHash,
                fullText: funcDeclNode.text,
            });
        }
    }
}
