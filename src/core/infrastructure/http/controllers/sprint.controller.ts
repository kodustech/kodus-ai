import { SprintRetroUseCase } from '@/core/application/use-cases/sprint/sprintRetro.use-case';
import { Body, Controller, Get, Post, Put } from '@nestjs/common';

@Controller('sprint')
export class SprintController {
    constructor(private readonly sprintRetroUseCase: SprintRetroUseCase) {}

    @Post('/retro')
    public async create(@Body() body) {
        return await this.sprintRetroUseCase.execute(body);
    }
}
