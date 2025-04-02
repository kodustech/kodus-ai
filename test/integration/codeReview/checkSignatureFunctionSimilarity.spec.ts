// test/unit/core/infrastructure/adapters/services/codeBase/code-analyzer.spec.ts

import { FunctionAnalysis } from '@/core/infrastructure/adapters/services/codeBase/ast/contracts/CodeGraph';
import { CodeAnalyzerService } from '@/core/infrastructure/adapters/services/codeBase/ast/services/code-analyzer.service';
import { FunctionResult } from '@/core/infrastructure/adapters/services/codeBase/diffAnalyzer.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ILogService } from '@/core/domain/log/contracts/log.service.contracts';
import { normalizeSignature } from '@/shared/utils/codeBase/ast-helpers';

describe('CodeAnalyzerService', () => {
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
        jest.spyOn(logger, 'log').mockImplementation(() => {});
        jest.spyOn(logger, 'error').mockImplementation(() => {});
        jest.spyOn(logger, 'warn').mockImplementation(() => {});
        jest.spyOn(logger, 'debug').mockImplementation(() => {});
        jest.spyOn(logger, 'verbose').mockImplementation(() => {});

        codeAnalyzerService = new CodeAnalyzerService(logger);
    });

    describe('checkSignatureFunctionSimilarity', () => {
        it('should return true when functions have same signature hash', () => {
            const signatureHash = normalizeSignature(['id:string'], 'User');

            const addedFunction: FunctionResult = {
                name: 'processUser',
                fullName: 'UserService.processUser',
                functionHash: 'some-hash',
                signatureHash,
                node: {} as any,
                fullText: '',
                lines: 1,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/user/user.repository.ts',
                name: 'getUser',
                params: ['id:string'],
                returnType: 'User',
                calls: [],
                className: 'UserRepository',
                startLine: 1,
                endLine: 3,
                functionHash: 'another-hash',
                signatureHash,
                fullText: '',
                lines: 1,
            };

            const result = codeAnalyzerService.checkSignatureFunctionSimilarity(
                addedFunction,
                existingFunction,
            );

            expect(result).toBe(true);
        });

        it('should return false when functions have different signature hashes', () => {
            const addedFunction: FunctionResult = {
                name: 'processUser',
                fullName: 'UserService.processUser',
                functionHash: 'some-hash',
                signatureHash: normalizeSignature(['userId:uuid'], 'User'),
                node: {} as any,
                fullText: '',
                lines: 1,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/user/user.repository.ts',
                name: 'getUser',
                params: ['name:string'],
                returnType: 'User',
                calls: [],
                className: 'UserRepository',
                startLine: 1,
                endLine: 3,
                functionHash: 'another-hash',
                signatureHash: normalizeSignature(['userId:string'], 'User'),
                fullText: '',
                lines: 1,
            };

            const result = codeAnalyzerService.checkSignatureFunctionSimilarity(
                addedFunction,
                existingFunction,
            );

            expect(result).toBe(false);
        });

        it('should return true for functions with same parameters in different order', () => {
            const addedFunction: FunctionResult = {
                name: 'validateUser',
                fullName: 'UserService.validateUser',
                functionHash: 'some-hash',
                signatureHash: normalizeSignature(
                    ['name:string', 'age:number'],
                    'boolean',
                ),
                node: {} as any,
                fullText: '',
                lines: 1,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/user/user.repository.ts',
                name: 'checkUser',
                params: ['age:number', 'name:string'], // Mesmos parâmetros em ordem diferente
                returnType: 'boolean',
                calls: [],
                className: 'UserRepository',
                startLine: 1,
                endLine: 3,
                functionHash: 'another-hash',
                signatureHash: normalizeSignature(
                    ['age:number', 'name:string'],
                    'boolean',
                ),
                fullText: '',
                lines: 1,
            };

            const result = codeAnalyzerService.checkSignatureFunctionSimilarity(
                addedFunction,
                existingFunction,
            );

            expect(result).toBe(true);
        });

        it('should return true when functions have same parameter types but different names', () => {
            const addedFunction: FunctionResult = {
                name: 'processUser',
                fullName: 'UserService.processUser',
                functionHash: 'some-hash',
                signatureHash: normalizeSignature(['userId:string'], 'User'),
                node: {} as any,
                fullText: '',
                lines: 1,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/user/user.repository.ts',
                name: 'getUser',
                params: ['name:string'],
                returnType: 'User',
                calls: [],
                className: 'UserRepository',
                startLine: 1,
                endLine: 3,
                functionHash: 'another-hash',
                signatureHash: normalizeSignature(['name:string'], 'User'),
                fullText: '',
                lines: 1,
            };

            const result = codeAnalyzerService.checkSignatureFunctionSimilarity(
                addedFunction,
                existingFunction,
            );

            expect(result).toBe(true); // Deve ser true pois ambos são (string) => User
        });

        it('should return false when functions have different parameter types', () => {
            const addedFunction: FunctionResult = {
                name: 'processUser',
                fullName: 'UserService.processUser',
                functionHash: 'some-hash',
                signatureHash: normalizeSignature(['id:number'], 'User'), // number
                node: {} as any,
                fullText: '',
                lines: 1,
            };

            const existingFunction: FunctionAnalysis = {
                file: 'src/user/user.repository.ts',
                name: 'getUser',
                params: ['id:string'], // string
                returnType: 'User',
                calls: [],
                className: 'UserRepository',
                startLine: 1,
                endLine: 3,
                functionHash: 'another-hash',
                signatureHash: normalizeSignature(['id:string'], 'User'),
                fullText: '',
                lines: 1,
            };

            const result = codeAnalyzerService.checkSignatureFunctionSimilarity(
                addedFunction,
                existingFunction,
            );

            expect(result).toBe(false); // Deve ser false pois são (number) => User vs (string) => User
        });
    });
});
