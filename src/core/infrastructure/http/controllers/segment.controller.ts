import { TrackUseCase } from '@/core/application/use-cases/segment/track.use-case';
import { Body, Controller, Post } from '@nestjs/common';

@Controller('segment')
export class SegmentController {
    constructor(private readonly trackUseCase: TrackUseCase) {}

    @Post('/track')
    public async track(@Body() body: any) {
        return this.trackUseCase.execute(body);
    }
}
