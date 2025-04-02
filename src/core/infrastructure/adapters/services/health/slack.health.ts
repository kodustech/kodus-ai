import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator } from '@nestjs/terminus';
import axios from 'axios';

@Injectable()
export class SlackHealthIndicator extends HealthIndicator {
    async isSlackHealthy() {
        try {
            const response = await axios.get(process.env.API_SLACK_URL_HEALTH);
            const status = response.data.status;
            const isHealthy = status === 'ok';

            if (isHealthy) {
                return this.getStatus('slack', true);
            }
            throw new HealthCheckError(
                'Slack check failed',
                this.getStatus('slack', false),
            );
        } catch (error) {
            throw new HealthCheckError(
                'Slack check failed',
                this.getStatus('slack', false),
            );
        }
    }
}
