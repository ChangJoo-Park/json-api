import Query, { QueryOptions } from "./Query";
import Resource from '../Resource';
import Data from '../Data';

export type CreateQueryOptions = QueryOptions & {
  records: Data<Resource>
}

export default class CreateQuery extends Query {
  protected query: {
    type: QueryOptions['type'];
    returning: QueryOptions['returning'];
    catch: QueryOptions['catch'];
    records: CreateQueryOptions['records'];
  };

  constructor({ records, ...baseOpts }: CreateQueryOptions) {
    super(baseOpts);
    this.query = {
      ...this.query,
      records: records
    };
  }

  get records() {
    return this.query.records;
  }
}
