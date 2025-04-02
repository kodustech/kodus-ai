import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { GetPullRequestAuthorsUseCase } from '@/core/application/use-cases/pullRequests/get-pull-request-authors-orderedby-contributions.use-case';
import { UpdatePullRequestToNewFormatUseCase } from '@/core/application/use-cases/pullRequests/update-pull-request-to-new-format.use-case';
import { updatePullRequestDto } from '../dtos/update-pull-request.dto';

@Controller('pull-requests')
export class PullRequestController {
    constructor(
        private readonly getPullRequestAuthorsUseCase: GetPullRequestAuthorsUseCase,
        private readonly updatePullRequestToNewFormatUseCase: UpdatePullRequestToNewFormatUseCase
    ) { }

    @Get('/get-pull-request-authors')
    public async getPullRequestAuthors(
        @Query() query: { organizationId: string },
    ) {
        return await this.getPullRequestAuthorsUseCase.execute(
            query.organizationId,
        );
    }

    @Post('/update-pull-requests')
    public async updatePullRequestToNewFormat(
        @Body() body: updatePullRequestDto,
    ) {
        return await this.updatePullRequestToNewFormatUseCase.execute(
            body
        );
    }
}
