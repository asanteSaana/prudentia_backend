import {UserRole} from '../_typings/types';

/** A row of `users`. `password_hash` must never leave this layer. */
export interface UserRecord {
	id: number;
	email: string;
	password_hash: string;
	full_name: string;
	role: UserRole;
	is_active: boolean;
	created_at: Date;
}

/** What a successful login returns. Note the absence of anything password-shaped. */
export interface LoginResult {
	accessToken: string;
	email: string;
	fullName: string;
	role: UserRole;
	expiresAt: string;
}
