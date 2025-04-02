export const EXECUTE_AUTOMATION_SERVICE_TOKEN = Symbol(
    'ExecuteAutomationService',
);

export interface IExecuteAutomationService {
    executeStrategy(name: string, payload?: any): Promise<any>;
    setupStrategy(name: string, payload?: any): Promise<any>;
    stopStrategy(name: string, payload?: any): Promise<any>;
    getAutomationMethods(name: string): Promise<any>;
}
