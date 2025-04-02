import { ActiveOrganizationAutomationsUseCase } from "./activeOrganizationAutomationsUseCase";
import { GetOrganizationAutomationUseCase } from "./getOrganizationAutomationUseCase";
import { RunOrganizationAutomationsUseCase } from "./run-organization-automations";
import { UpdateOrCreateOrganizationAutomationUseCase } from "./updateOrCreateOrganizationAutomationUseCase";

export const UseCases = [
    GetOrganizationAutomationUseCase,
    ActiveOrganizationAutomationsUseCase,
    UpdateOrCreateOrganizationAutomationUseCase,
    RunOrganizationAutomationsUseCase
];
