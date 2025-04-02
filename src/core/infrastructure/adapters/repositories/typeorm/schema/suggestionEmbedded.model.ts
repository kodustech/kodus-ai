import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { OrganizationModel } from './organization.model';
import { VectorColumn } from '../columnType/vector.type';
@Entity('suggestion_embedded', {
    synchronize: false,
})
export class SuggestionEmbeddedModel extends CoreModel {
    @VectorColumn()
    suggestionEmbed: number[];

    @Column()
    pullRequestNumber: number;

    @Column()
    repositoryId: string;

    @Column()
    repositoryFullName: string;

    @Column()
    suggestionId: string;
    @Column()
    label: string;

    @Column()
    severity: string;

    @Column()
    feedbackType: string;

    @Column('text')
    improvedCode: string;

    @Column('text')
    suggestionContent: string;

    @Column({ nullable: true })
    language: string;

    @ManyToOne(() => OrganizationModel, (organization) => organization.teams)
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;
}
