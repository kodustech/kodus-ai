import { Column, Entity, OneToMany, Unique } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

import type { AstNodeModel } from './astNode.model';
import type { AstEdgeModel } from './astEdge.model';

export enum AstGraphStatus {
    PENDING = 'pending',
    BUILDING = 'building',
    READY = 'ready',
    FAILED = 'failed',
}

@Entity('repositories')
@Unique('UQ_repositories_platform_external', ['platform', 'externalId'])
export class RepositoryModel extends CoreModel {
    @Column({ type: 'uuid', name: 'integration_config_id' })
    integrationConfigId: string;

    @Column({ type: 'text', name: 'external_id' })
    externalId: string;

    @Column({ type: 'text' })
    name: string;

    @Column({ type: 'text', name: 'full_name' })
    fullName: string;

    @Column({ type: 'text' })
    platform: string;

    @Column({ type: 'text', name: 'default_branch', default: 'main' })
    defaultBranch: string;

    @Column({
        type: 'enum',
        enum: AstGraphStatus,
        name: 'ast_graph_status',
        default: AstGraphStatus.PENDING,
        nullable: true,
    })
    astGraphStatus: AstGraphStatus;

    @Column({ type: 'text', name: 'ast_graph_sha', nullable: true })
    astGraphSha: string | null;

    @Column({ type: 'timestamp', name: 'ast_graph_built_at', nullable: true })
    astGraphBuiltAt: Date | null;

    @Column({ type: 'integer', name: 'ast_graph_node_count', default: 0 })
    astGraphNodeCount: number;

    @Column({ type: 'integer', name: 'ast_graph_edge_count', default: 0 })
    astGraphEdgeCount: number;

    @OneToMany('AstNodeModel', 'repository')
    astNodes: AstNodeModel[];

    @OneToMany('AstEdgeModel', 'repository')
    astEdges: AstEdgeModel[];
}
