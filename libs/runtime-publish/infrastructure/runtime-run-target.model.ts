import { Column, Entity, Index } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

/** Publish target of a Run, written by the product at enqueue time (§8: product Postgres, only the product writes). */
@Entity('runtime_run_targets')
@Index('UQ_runtime_run_targets_run', ['runId'], { unique: true })
export class RuntimeRunTargetModel extends CoreModel {
    @Column({ name: 'run_id', type: 'varchar', length: 128 })
    runId: string;

    @Column({ type: 'integer' })
    attempt: number;

    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'team_id', type: 'varchar', length: 128 })
    teamId: string;

    @Column({ name: 'repository_id', type: 'varchar', length: 128 })
    repositoryId: string;

    @Column({ name: 'repository_name', type: 'varchar', length: 256 })
    repositoryName: string;

    @Column({ name: 'repository_full_name', type: 'varchar', length: 512, nullable: true })
    repositoryFullName: string | null;

    @Column({ type: 'varchar', length: 32 })
    platform: string;

    @Column({ name: 'pr_number', type: 'integer' })
    pullRequestNumber: number;

    @Column({ name: 'head_sha', type: 'varchar', length: 40 })
    headSha: string;
}
