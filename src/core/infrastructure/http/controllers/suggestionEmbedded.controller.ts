import { Controller, Get, Query } from '@nestjs/common';
import { SuggestionEmbeddedService } from '../../../../ee/kodyFineTuning/suggestionEmbedded/suggestionEmbedded.service';

@Controller('suggestion-embedded')
export class SuggestionEmbeddedController {
    constructor(
        private readonly suggestionEmbeddedService: SuggestionEmbeddedService,
    ) {}

    @Get('/organization')
    async getSuggestionEmbeddedByOrganization(
        @Query('organizationId') organizationId: string,
    ) {
        return this.suggestionEmbeddedService.getByOrganization(organizationId);
    }

    @Get('/repository')
    async getSuggestionEmbedded(
        @Query('organizationId') organizationId: string,
        @Query('repositoryId') repositoryId: string,
    ) {
        return this.suggestionEmbeddedService.getByRepositoryAndOrganization(
            repositoryId,
            organizationId,
        );
    }

    @Get('/organization/languages')
    async getSuggestionEmbeddedByOrganizationWithLanguages(
        @Query('organizationId') organizationId: string,
    ) {
        return this.suggestionEmbeddedService.getByOrganizationWithLanguages(
            organizationId,
        );
    }

    @Get('/repository/languages')
    async getSuggestionEmbeddedByRepositoryWithLanguages(
        @Query('organizationId') organizationId: string,
        @Query('repositoryId') repositoryId: string,
    ) {
        return this.suggestionEmbeddedService.getByRepositoryAndOrganizationWithLanguages(
            repositoryId,
            organizationId,
        );
    }
}
