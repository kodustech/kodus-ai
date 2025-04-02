import { Injectable } from '@nestjs/common';
import { track } from '@/shared/utils/segment';

@Injectable()
export class TrackUseCase {
    constructor() {}

    async execute(data: {
        userId: string;
        event: string;
        properties?: any;
    }): Promise<void> {
        const { userId, event, properties } = data;

        track(userId, event, properties);
    }
}
