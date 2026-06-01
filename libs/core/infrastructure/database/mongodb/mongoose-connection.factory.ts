import { Connection } from 'mongoose';

import { mongooseHideObjectId } from '@libs/common/utils/mongo-utils';

// `mongoose-paginate` is a CJS module whose `module.exports` IS the
// plugin function. With `import * as x`, ts-node wraps it into a
// namespace object (has `.default`, `.paginate`, etc.) and Mongoose
// rejects the plugin as "not a function" — while the regular
// build (tsc/SWC → `require()`) returns the function directly and
// works. `import = require` compiles identically under both pipelines
// and avoids the namespace wrapping entirely.
import mongoosePaginate = require('mongoose-paginate');

export class MongooseConnectionFactory {
    public static createForInstance(connection: Connection): Connection {
        connection.plugin(mongooseHideObjectId);
        connection.plugin(mongoosePaginate);
        return connection;
    }
}
