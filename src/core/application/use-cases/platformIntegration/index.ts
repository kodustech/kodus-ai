import codeManagementUseCases from './codeManagement';
import communicationUseCases from './communication';
import projectManagementUseCases from './projectManagement';

export const UseCases = [
    ...projectManagementUseCases,
    ...communicationUseCases,
    ...codeManagementUseCases,
];
