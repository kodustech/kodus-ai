import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    MongooseModuleOptions,
    MongooseOptionsFactory,
} from '@nestjs/mongoose';
import mongoose from 'mongoose';
import { ConnectionString } from 'connection-string';
import { DatabaseConnection } from '@/config/types';
import { MongooseConnectionFactory } from './mongoose-connection.factory';

mongoose.set('debug', false);

@Injectable()
export class MongooseFactory implements MongooseOptionsFactory {
    protected config: DatabaseConnection;

    constructor(private readonly configService: ConfigService) {
        this.config = configService.get<DatabaseConnection>('mongoDatabase');
    }

    public createMongooseOptions(): MongooseModuleOptions {
        let uri = new ConnectionString('', {
            user: this.config.username,
            password: this.config.password,
            protocol: this.config.port ? 'mongodb' : 'mongodb+srv',
            hosts: [{ name: this.config.host, port: this.config.port }],
        }).toString();

        const { createForInstance } = MongooseConnectionFactory;

        if (process.env.API_NODE_ENV === 'production') {
            uri = `${uri}/${process.env.API_MG_DB_PRODUCTION_CONFIG}`;
        }

        return {
            uri: uri,
            dbName: this.config.database,
            connectionFactory: createForInstance,
            minPoolSize: 2,
            maxIdleTimeMS: 50000,
        };
    }
}
