import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator } from '@nestjs/terminus';
import axios from 'axios';

@Injectable()
export class JiraHealthIndicator extends HealthIndicator {
    async isJiraHealthy() {
        try {
            const response = await axios.get(process.env.JIRA_URL_HEALTH);
            const status = response.data.status.indicator;
            const isHealthy = status === 'none';

            if (isHealthy) {
                return this.getStatus('jira', true);
            }
            throw new HealthCheckError(
                'Jira check failed',
                this.getStatus('jira', false),
            );
        } catch (error) {
            throw new HealthCheckError(
                'Jira check failed',
                this.getStatus('jira', false),
            );
        }
    }
}
