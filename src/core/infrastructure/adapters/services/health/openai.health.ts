import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator } from '@nestjs/terminus';
import axios from 'axios';

@Injectable()
export class OpenAIHealthIndicator extends HealthIndicator {
    async isOpenAIHealthy() {
        try {
            const response = await axios.get(process.env.OPEN_AI_URL_HEALTH);
            const status = response.data.status.indicator;
            const isHealthy = status === 'none';

            if (isHealthy) {
                return this.getStatus('openai', true);
            }
            throw new HealthCheckError(
                'OpenAI check failed',
                this.getStatus('openai', false),
            );
        } catch (error) {
            throw new HealthCheckError(
                'OpenAI check failed',
                this.getStatus('openai', false),
            );
        }
    }
}
