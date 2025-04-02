import { registerAs } from '@nestjs/config';
import { RabbitMQConfig } from '../types/environment/rabbitMQ.type';

export const RabbitMQLoader = registerAs(
    'rabbitMQConfig',
    (): RabbitMQConfig => ({
        API_RABBITMQ_URI: process.env.API_RABBITMQ_URI || 'amqp://localhost:5672/',
        API_RABBITMQ_ENABLED: process.env.API_RABBITMQ_ENABLED === 'true' || true,
    }),
);
