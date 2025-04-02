import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator } from '@nestjs/terminus';
import axios from 'axios';

@Injectable()
export class GitHubHealthIndicator extends HealthIndicator {
    async isGitHubHealthy() {
        try {
            const response = await axios.get(process.env.GITHUB_URL_HEALTH);
            const status = response.data.status.indicator;
            const isHealthy = status === 'none';

            if (isHealthy) {
                return this.getStatus('github', true);
            }
            throw new HealthCheckError(
                'GitHub check failed',
                this.getStatus('github', false),
            );
        } catch (error) {
            throw new HealthCheckError(
                'GitHub check failed',
                this.getStatus('github', false),
            );
        }
    }
}
