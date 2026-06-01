import { PlatformIntegrationFactory } from '../platformIntegration.factory';
import { ICodeManagementService } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

describe('PlatformIntegrationFactory', () => {
    let factory: PlatformIntegrationFactory;

    beforeEach(() => {
        factory = new PlatformIntegrationFactory();
    });

    describe('getCodeManagementService', () => {
        it('should throw error for null type', () => {
            expect(() => factory.getCodeManagementService(null)).toThrow(
                "Repository service for type 'null' not found.",
            );
        });

        it('should throw error for unregistered type', () => {
            expect(() => factory.getCodeManagementService('UNKNOWN')).toThrow(
                "Repository service for type 'UNKNOWN' not found.",
            );
        });

        it('should return the correct service for a registered type', () => {
            const mockService = {
                countReactions: jest.fn(),
            } as unknown as ICodeManagementService;

            factory.registerCodeManagementService('GITHUB', mockService);

            expect(factory.getCodeManagementService('GITHUB')).toBe(
                mockService,
            );
        });
    });
});
