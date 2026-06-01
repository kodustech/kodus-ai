import {
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    Unique,
} from 'typeorm';

import type { RepositoryModel } from './repository.model';

@Entity('ast_edges')
@Unique('UQ_ast_edges_repo_kind_src_tgt', [
    'repoId',
    'kind',
    'sourceQualified',
    'targetQualified',
])
@Index('idx_ast_edges_repo_source', ['repoId', 'sourceQualified'])
@Index('idx_ast_edges_repo_target', ['repoId', 'targetQualified'])
@Index('idx_ast_edges_repo_kind', ['repoId', 'kind'])
@Index('idx_ast_edges_repo_file', ['repoId', 'filePath'])
export class AstEdgeModel {
    @PrimaryGeneratedColumn({ type: 'bigint' })
    id: string;

    @Column({ type: 'uuid', name: 'repo_id' })
    repoId: string;

    @Column({ type: 'text' })
    kind: string;

    @Column({ type: 'text', name: 'source_qualified' })
    sourceQualified: string;

    @Column({ type: 'text', name: 'target_qualified' })
    targetQualified: string;

    @Column({ type: 'text', name: 'file_path' })
    filePath: string;

    @Column({ type: 'integer', default: 0 })
    line: number;

    @Column({ type: 'real', nullable: true })
    confidence: number | null;

    @ManyToOne('RepositoryModel', 'astEdges', { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'repo_id', referencedColumnName: 'uuid' })
    repository: RepositoryModel;
}
