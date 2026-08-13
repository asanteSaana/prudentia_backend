import Auth from './AuthHandler';

export const routes = [
	['post', '/v1/auth/login', Auth.login],
	['post', '/v1/auth/logout', Auth.logout],
	['get', '/v1/auth/me', Auth.me]
];
