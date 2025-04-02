import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import { ICommunicationService } from '@/core/domain/platformIntegrations/interfaces/communication.interface';
import { IProjectManagementService } from '@/core/domain/platformIntegrations/interfaces/project-management.interface';
import { Injectable } from '@nestjs/common';

@Injectable()
export class PlatformIntegrationFactory {
    private projectManagementServices = new Map<
        string,
        IProjectManagementService
    >();
    private codeManagementServices = new Map<string, ICodeManagementService>();
    private communicationServices = new Map<string, ICommunicationService>();

    registerProjectManagementService(
        type: string,
        service: IProjectManagementService,
    ) {
        this.projectManagementServices.set(type, service);
    }

    registerCodeManagementService(
        type: string,
        service: ICodeManagementService,
    ) {
        this.codeManagementServices.set(type, service);
    }

    registerCommunicationService(type: string, service: ICommunicationService) {
        this.communicationServices.set(type, service);
    }

    getProjectManagementService(type: string): IProjectManagementService {
        const service = this.projectManagementServices.get(type);

        if (!service) {
            throw new Error(`Board service for type '${type}' not found.`);
        }
        return service;
    }

    getCodeManagementService(type: string): ICodeManagementService {
        const service = this.codeManagementServices.get(type);

        if (!service) {
            throw new Error(`Repository service for type '${type}' not found.`);
        }
        return service;
    }

    getCommunicationService(type: string): ICommunicationService {
        const service = this.communicationServices.get(type);

        if (!service) {
            throw new Error(`Repository service for type '${type}' not found.`);
        }

        return service;
    }
}
