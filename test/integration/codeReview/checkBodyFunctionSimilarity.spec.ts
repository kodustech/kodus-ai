// test/unit/core/infrastructure/adapters/services/codeBase/code-analyzer.spec.ts


import Parser = require('tree-sitter');
import * as TypeScript from 'tree-sitter-typescript/typescript';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ILogService } from '@/core/domain/log/contracts/log.service.contracts';
import {
    normalizeAST,
    normalizeSignature,
} from '@/shared/utils/codeBase/ast-helpers';
import { CodeAnalyzerService } from '@/ee/codeBase/ast/services/code-analyzer.service';
import { FunctionResult } from '@/ee/codeBase/diffAnalyzer.service';
import { FunctionAnalysis } from '@/ee/codeBase/ast/contracts/CodeGraph';

describe('CodeAnalyzerService', () => {
    let codeAnalyzerService: CodeAnalyzerService;
    let mockLogService: ILogService;
    let logger: PinoLoggerService;
    let parser: Parser;

    beforeAll(() => {
        parser = new Parser();
        parser.setLanguage(TypeScript);
    });

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
        jest.spyOn(logger, 'log').mockImplementation(() => {});
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        jest.spyOn(logger, 'warn').mockImplementation(() => {});
        jest.spyOn(logger, 'debug').mockImplementation(() => {});
        jest.spyOn(logger, 'verbose').mockImplementation(() => {});

        codeAnalyzerService = new CodeAnalyzerService(logger);
    });
    describe('checkBodyFunctionSimilarity', () => {
        it('should compare function bodies correctly', async () => {
            console.log('🔍 Iniciando teste de comparação de corpos...');

            // Duas funções com mesma lógica, mas nomes diferentes
            const addedFunctionTree = parser.parse(`
                function validateUser(id: string): boolean {
                    const user = findUser(id);
                    return user.isActive;
                }
            `);

            const existingFunctionTree = parser.parse(`
                function checkStatus(userId: string): boolean {
                    const account = findUser(userId);
                    return account.isActive;
                }
            `);

            const addedFunction: FunctionResult = {
                name: 'validateUser',
                fullName: 'UserService.validateUser',
                functionHash: normalizeAST(addedFunctionTree.rootNode),
                signatureHash: normalizeSignature(['id:string'], 'boolean'),
                node: addedFunctionTree.rootNode,
                fullText: '',
                lines: 3,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/user/user.repository.ts',
                name: 'checkStatus',
                params: ['userId:string'],
                lines: 3,
                returnType: 'boolean',
                calls: [],
                className: 'UserRepository',
                startLine: 1,
                endLine: 3,
                functionHash: normalizeAST(existingFunctionTree.rootNode),
                signatureHash: normalizeSignature(['userId:string'], 'boolean'),
                fullText: '',
            };

            console.log('🔍 Chamando checkFunctionSimilarity...');
            const result =
                await codeAnalyzerService.checkBodyFunctionSimilarity(
                    addedFunction,
                    existingFunction,
                );

            console.log('✅ Verificando resultados...');
            expect(result.isSimilar).toBe(true);
        });

        it('should identify functions with different implementations but same purpose', async () => {
            console.log('🔍 Iniciando teste de implementações diferentes...');

            // Primeira implementação: usa uma única chamada e optional chaining
            const addedFunctionTree = parser.parse(`
                function checkUserAccess(userId: string): boolean {
                    const user = findUser(userId);
                    return user?.isActive && user?.hasPermission;
                }
            `);

            // Segunda implementação: usa múltiplas chamadas e try/catch
            const existingFunctionTree = parser.parse(`
                function validatePermission(id: string): boolean {
                    try {
                        const status = getUserStatus(id);
                        const permissions = getUserPermissions(id);
                        return status === 'active' && permissions.length > 0;
                    } catch {
                        return false;
                    }
                }
            `);

            const addedFunction: FunctionResult = {
                name: 'checkUserAccess',
                fullName: 'UserService.checkUserAccess',
                functionHash: normalizeAST(addedFunctionTree.rootNode),
                signatureHash: normalizeSignature(['userId:string'], 'boolean'),
                node: addedFunctionTree.rootNode,
                fullText: '',
                lines: 3,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/user/user.repository.ts',
                name: 'validatePermission',
                params: ['id:string'],
                lines: 8,
                returnType: 'boolean',
                calls: [],
                className: 'UserRepository',
                startLine: 1,
                endLine: 8,
                functionHash: normalizeAST(existingFunctionTree.rootNode),
                signatureHash: normalizeSignature(['id:string'], 'boolean'),
                fullText: '',
            };

            console.log('🔍 Chamando checkFunctionSimilarity...');
            const result =
                await codeAnalyzerService.checkBodyFunctionSimilarity(
                    addedFunction,
                    existingFunction,
                );

            console.log('✅ Verificando resultados...');
            expect(result.isSimilar).toBe(true);
        });

        it('should identify functions with completely different implementations but same purpose', async () => {
            console.log(
                '🔍 Iniciando teste de implementações radicalmente diferentes...',
            );

            // Primeira implementação: Orientada a eventos/callbacks
            const addedFunctionTree = parser.parse(`
                function validateUserAccess(userId: string): Promise<boolean> {
                    return new Promise((resolve) => {
                        eventEmitter.emit('check-user', userId, (status) => {
                            resolve(status.canAccess && status.isEnabled);
                        });
                    });
                }
            `);

            // Segunda implementação: Orientada a queries/banco de dados
            const existingFunctionTree = parser.parse(`
                function checkUserPermission(id: string): Promise<boolean> {
                    const query = \`
                        SELECT COUNT(*) as valid
                        FROM users u
                        JOIN user_permissions up ON u.id = up.user_id
                        WHERE u.id = ?
                        AND u.active = true
                        AND up.enabled = true
                    \`;

                    const result = await database.execute(query, [id]);
                    return result[0].valid > 0;
                }
            `);

            const addedFunction: FunctionResult = {
                name: 'validateUserAccess',
                fullName: 'UserService.validateUserAccess',
                functionHash: normalizeAST(addedFunctionTree.rootNode),
                signatureHash: normalizeSignature(
                    ['userId:string'],
                    'Promise<boolean>',
                ),
                node: addedFunctionTree.rootNode,
                fullText: '',
                lines: 3,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/user/user.repository.ts',
                name: 'checkUserPermission',
                params: ['id:string'],
                lines: 12,
                returnType: 'Promise<boolean>',
                calls: [],
                className: 'UserRepository',
                startLine: 1,
                endLine: 12,
                functionHash: normalizeAST(existingFunctionTree.rootNode),
                signatureHash: normalizeSignature(
                    ['id:string'],
                    'Promise<boolean>',
                ),
                fullText: '',
            };

            console.log('🔍 Chamando checkFunctionSimilarity...');
            const result =
                await codeAnalyzerService.checkBodyFunctionSimilarity(
                    addedFunction,
                    existingFunction,
                );

            console.log('✅ Verificando resultados...');
            expect(result.isSimilar).toBe(true);
        });

        it('should not identify completely different functions as similar', async () => {
            console.log(
                '🔍 Iniciando teste de funções totalmente diferentes...',
            );

            // Primeira função: Validação de usuário
            const addedFunctionTree = parser.parse(`
                function validateUserAccess(userId: string): boolean {
                    const user = findUser(userId);
                    if (!user?.isActive) {
                        logAccess('inactive_user', userId);
                        return false;
                    }
                    return checkPermissions(user.roles);
                }
            `);

            // Segunda função: Processamento de imagem (totalmente diferente)
            const existingFunctionTree = parser.parse(`
                function applyImageFilter(imageData: Uint8Array): Uint8Array {
                    const width = Math.sqrt(imageData.length / 4);
                    const result = new Uint8Array(imageData.length);

                    for (let i = 0; i < imageData.length; i += 4) {
                        const r = imageData[i];
                        const g = imageData[i + 1];
                        const b = imageData[i + 2];
                        const a = imageData[i + 3];

                        // Aplicar filtro de sépia
                        result[i] = Math.min(255, (r * 0.393) + (g * 0.769) + (b * 0.189));
                        result[i + 1] = Math.min(255, (r * 0.349) + (g * 0.686) + (b * 0.168));
                        result[i + 2] = Math.min(255, (r * 0.272) + (g * 0.534) + (b * 0.131));
                        result[i + 3] = a;
                    }

                    return result;
                }
            `);

            const addedFunction: FunctionResult = {
                name: 'validateUserAccess',
                fullName: 'UserService.validateUserAccess',
                functionHash: normalizeAST(addedFunctionTree.rootNode),
                signatureHash: normalizeSignature(['userId:string'], 'boolean'),
                node: addedFunctionTree.rootNode,
                fullText: '',
                lines: 3,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/image/image.service.ts',
                name: 'applyImageFilter',
                params: ['imageData:Uint8Array'],
                lines: 15,
                returnType: 'Uint8Array',
                calls: [],
                className: 'ImageService',
                startLine: 1,
                endLine: 15,
                functionHash: normalizeAST(existingFunctionTree.rootNode),
                signatureHash: normalizeSignature(
                    ['imageData:Uint8Array'],
                    'Uint8Array',
                ),
                fullText: '',
            };

            console.log('🔍 Chamando checkFunctionSimilarity...');
            const result =
                await codeAnalyzerService.checkBodyFunctionSimilarity(
                    addedFunction,
                    existingFunction,
                );

            console.log('✅ Verificando resultados...');
            expect(result.isSimilar).toBe(false);
        });
    });
});
