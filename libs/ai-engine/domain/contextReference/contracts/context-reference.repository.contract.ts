import { ContextReferenceEntity } from '../entities/context-reference.entity';
import { IContextReference } from '../interfaces/context-reference.interface';

export const CONTEXT_REFERENCE_REPOSITORY_TOKEN = Symbol(
    'ContextReferenceRepository',
);

export interface IContextReferenceRepository {
    create(
        contextReference: IContextReference,
    ): Promise<ContextReferenceEntity | undefined>;

    find(
        filter?: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity[]>;

    findOne(
        filter: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity | undefined>;

    findById(uuid: string): Promise<ContextReferenceEntity | undefined>;

    /**
     * Batch variant of findById — resolves many references in a single
     * query (`uuid IN (...)`). Used to avoid the N+1 that arises when a
     * caller enriches a list of entities that each point at a context
     * reference (e.g. the Kody Rules listing). Order is not guaranteed;
     * callers should index the result by `uuid`.
     */
    findByIds(uuids: string[]): Promise<ContextReferenceEntity[]>;

    update(
        filter: Partial<IContextReference>,
        data: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity | undefined>;

    delete(uuid: string): Promise<void>;
}
