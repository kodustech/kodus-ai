export enum AutomationType {
    AUTOMATION_TEAM_PROGRESS = 'AutomationTeamProgress',
    AUTOMATION_INTERACTION_MONITOR = 'AutomationInteractionMonitor',
    AUTOMATION_ISSUES_DETAILS = 'AutomationIssuesDetails',
    AUTOMATION_IMPROVE_TASK = 'AutomationImproveTask',
    AUTOMATION_ENSURE_ASSIGNEES = 'AutomationEnsureAssignees',
    AUTOMATION_COMMIT_VALIDATION = 'AutomationCommitValidation',
    AUTOMATION_WIP_LIMITS = 'AutomationWipLimits',
    AUTOMATION_WAITING_CONSTRAINTS = 'AutomationWaitingConstraints',
    AUTOMATION_TASK_BREAKDOWN = 'AutomationTaskBreakdown',
    AUTOMATION_USER_REQUESTED_BREAKDOWN = 'AutomationUserRequestedBreakdown',
    AUTOMATION_RETROACTIVE_MOVEMENT = 'AutomationRetroactiveMovement',
    AUTOMATION_DAILY_CHECKIN = 'AutomationDailyCheckin',
    AUTOMATION_SPRINT_RETRO = 'AutomationSprintRetro',
    AUTOMATION_EXECUTIVE_CHECKIN = 'AutomationExecutiveCheckin',
    AUTOMATION_CODE_REVIEW = 'AutomationCodeReview',
}

export enum AutomationTypeCategory {
    CODE_MANAGEMENT = 'CodeManagementAutomations',
    PROJECT_MANAGEMENT = 'TaskManagementAutomations',
    COMMUNICATION_MANAGEMENT = 'CommunicationAutomations',
}

// Define a mapping object to relate AutomationType with their respective categories
export const AutomationCategoryMapping: Record<
    AutomationTypeCategory,
    AutomationType[]
> = {
    [AutomationTypeCategory.CODE_MANAGEMENT]: [
        AutomationType.AUTOMATION_CODE_REVIEW,
    ],
    [AutomationTypeCategory.PROJECT_MANAGEMENT]: [
        AutomationType.AUTOMATION_IMPROVE_TASK,
    ],
    [AutomationTypeCategory.COMMUNICATION_MANAGEMENT]: [
        AutomationType.AUTOMATION_TEAM_PROGRESS,
        AutomationType.AUTOMATION_DAILY_CHECKIN,
        AutomationType.AUTOMATION_SPRINT_RETRO,
        AutomationType.AUTOMATION_EXECUTIVE_CHECKIN,
    ],
};
