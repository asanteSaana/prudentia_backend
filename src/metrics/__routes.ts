import Metrics from './MetricsHandler';

export const routes = [
	['get', '/v1/metrics/headline', Metrics.headline],
	['get', '/v1/metrics/trend', Metrics.trend],
	['get', '/v1/metrics/schema', Metrics.schema]
];
