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

@Entity('ast_nodes')
@Unique('UQ_ast_nodes_repo_qualified', ['repoId', 'qualifiedName'])
@Index('idx_ast_nodes_repo_file', ['repoId', 'filePath'])
@Index('idx_ast_nodes_repo_kind', ['repoId', 'kind'])
@Index('idx_ast_nodes_repo_qual', ['repoId', 'qualifiedName'])
export class AstNodeModel {
    @PrimaryGeneratedColumn({ type: 'bigint' })
    id: string;

    @Column({ type: 'uuid', name: 'repo_id' })
    repoId: string;

    @Column({ type: 'text' })
    kind: string;

    @Column({ type: 'text' })
    name: string;

    @Column({ type: 'text', name: 'qualified_name' })
    qualifiedName: string;

    @Column({ type: 'text', name: 'file_path' })
    filePath: string;

    @Column({ type: 'integer', name: 'line_start', nullable: true })
    lineStart: number | null;

    @Column({ type: 'integer', name: 'line_end', nullable: true })
    lineEnd: number | null;

    @Column({ type: 'text', nullable: true })
    language: string | null;

    @Column({ type: 'text', name: 'parent_name', nullable: true })
    parentName: string | null;

    @Column({ type: 'text', nullable: true })
    params: string | null;

    @Column({ type: 'text', name: 'return_type', nullable: true })
    returnType: string | null;

    @Column({ type: 'text', nullable: true })
    modifiers: string | null;

    @Column({ type: 'boolean', name: 'is_test', default: false })
    isTest: boolean;

    @Column({ type: 'text', name: 'file_hash', nullable: true })
    fileHash: string | null;

    @ManyToOne('RepositoryModel', 'astNodes', { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'repo_id', referencedColumnName: 'uuid' })
    repository: RepositoryModel;
}
