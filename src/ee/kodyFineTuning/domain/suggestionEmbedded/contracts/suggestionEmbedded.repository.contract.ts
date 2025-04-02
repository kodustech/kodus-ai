import { FindManyOptions } from "typeorm";
import { SuggestionEmbeddedEntity } from "../entities/suggestionEmbedded.entity";
import { ISuggestionEmbedded } from "../interfaces/suggestionEmbedded.interface";


export const SUGGESTION_EMBEDDED_REPOSITORY_TOKEN = Symbol(
    'SuggestionEmbeddedRepository',
);

export interface ISuggestionEmbeddedRepository {
    create(
        entity: ISuggestionEmbedded,
    ): Promise<SuggestionEmbeddedEntity | undefined>;

    find(
        filter?: Omit<Partial<ISuggestionEmbedded>, 'suggestionId'>,
        options?: FindManyOptions,
    ): Promise<SuggestionEmbeddedEntity[]>;

    findOne(
        suggestionId: string,
    ): Promise<SuggestionEmbeddedEntity | undefined>;

    findById(uuid: string): Promise<SuggestionEmbeddedEntity | undefined>;

    update(
        filter: Partial<ISuggestionEmbedded>,
        data: Partial<ISuggestionEmbedded>,
    ): Promise<SuggestionEmbeddedEntity | undefined>;
}
