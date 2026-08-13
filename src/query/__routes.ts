import Query from './QueryHandler';

export const routes = [
	['post', '/v1/query', Query.ask],
	['get', '/v1/query/history', Query.history],
	['get', '/v1/query/examples', Query.examples]
];
