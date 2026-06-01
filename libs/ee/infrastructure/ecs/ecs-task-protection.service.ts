import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { ITaskProtectionService } from '@libs/core/workflow/domain/contracts/task-protection.service.contract';

const DEFAULT_ECS_TASK_PROTECTION_TIMEOUT_MS = 5000;

@Injectable()
export class EcsTaskProtectionService implements ITaskProtectionService {
    private readonly logger = new Logger(EcsTaskProtectionService.name);
    private readonly ecsAgentUri: string | undefined;
    private readonly requestTimeoutMs: number;

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
    ) {
        const agentInjectedUri = process.env.ECS_AGENT_URI;
        const configOverrideUri =
            this.configService.get<string>('API_ECS_AGENT_URI');
        this.ecsAgentUri = agentInjectedUri || configOverrideUri || undefined;

        if (this.ecsAgentUri) {
            this.logger.log({
                message: 'ECS task protection configured',
                metadata: {
                    source: agentInjectedUri
                        ? 'ECS_AGENT_URI (agent-injected)'
                        : 'API_ECS_AGENT_URI (config override)',
                },
            } as any);
        }

        const configuredTimeout = this.configService.get<string>(
            'API_ECS_TASK_PROTECTION_TIMEOUT_MS',
        );
        const parsedTimeout = Number.parseInt(configuredTimeout ?? '', 10);
        this.requestTimeoutMs =
            Number.isFinite(parsedTimeout) && parsedTimeout > 0
                ? parsedTimeout
                : DEFAULT_ECS_TASK_PROTECTION_TIMEOUT_MS;
    }

    async protectTask(expiresInMinutes: number): Promise<void> {
        if (!this.ecsAgentUri) {
            this.logger.debug(
                'ECS_AGENT_URI not set, skipping task protection',
            );
            return;
        }

        try {
            await firstValueFrom(
                this.httpService
                    .put(
                        `${this.ecsAgentUri}/task-protection/v1/state`,
                        {
                            ProtectionEnabled: true,
                            ExpiresInMinutes: expiresInMinutes,
                        },
                        { timeout: this.requestTimeoutMs },
                    )
                    .pipe(
                        catchError((error: AxiosError) => {
                            this.logger.error(
                                `Failed to enable task protection. URI: ${this.ecsAgentUri}/task-protection/v1/state - Error: ${error.message}`,
                            );
                            throw error;
                        }),
                    ),
            );
            this.logger.log(
                `Task protection enabled for ${expiresInMinutes} minutes`,
            );
        } catch (error) {
            // Non-blocking error, just log
            this.logger.error({
                message: 'Error enabling task protection',
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                uri: this.ecsAgentUri,
            });
        }
    }

    async unprotectTask(): Promise<void> {
        if (!this.ecsAgentUri) {
            return;
        }

        try {
            await firstValueFrom(
                this.httpService
                    .put(
                        `${this.ecsAgentUri}/task-protection/v1/state`,
                        {
                            ProtectionEnabled: false,
                        },
                        { timeout: this.requestTimeoutMs },
                    )
                    .pipe(
                        catchError((error: AxiosError) => {
                            this.logger.error(
                                `Failed to disable task protection: ${error.message}`,
                            );
                            throw error;
                        }),
                    ),
            );
            this.logger.log('Task protection disabled');
        } catch (error) {
            this.logger.error({
                message: 'Error disabling task protection',
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                uri: this.ecsAgentUri,
            });
        }
    }
}
