import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity } from 'typeorm';
import { GlobalParametersKey } from '@/shared/domain/enums/global-parameters-key.enum';

@Entity('global_parameters')
export class GlobalParametersModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: GlobalParametersKey,
    })
    configKey: GlobalParametersKey;

    @Column({ type: 'jsonb' })
    configValue: any;

    @Column({ nullable: true })
    description: string;
}
