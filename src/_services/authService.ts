import crypto from 'crypto';
import {Constants} from './_constants';

/**
 * Password hashing (FR-02).
 *
 * `hashPassword`/`verifyPassword` are copied verbatim from the template estate
 * (`ghanacardverification/src/_services/authService.ts`), which uses scrypt rather than
 * bcrypt. Deviation DV-6 records the decision and why FR-02 is still satisfied: the
 * requirement asks for "a computationally expensive one-way hash with per-user salt",
 * and scrypt is exactly that — memory-hard, which bcrypt is not.
 *
 * The part not to paraphrase is `timingSafeEqual`. A plain `===` on the hex strings
 * would return early on the first differing byte, leaking through response timing how
 * much of a guess was correct. The length guard in front of it is also load-bearing:
 * `timingSafeEqual` THROWS on mismatched lengths rather than returning false.
 *
 * Work factor is scrypt's default — N=16384, r=8, p=1, roughly 16 MB and ~50–100 ms per
 * verification. That cost is not overhead, it is the TH-08 credential-stuffing control.
 */
export function hashPassword(pin: string): string {
	const salt = crypto.randomBytes(16).toString('hex');
	const buffer = crypto.scryptSync(pin, salt, 64) as Buffer;
	return `${salt}.${buffer.toString('hex')}`;
}

export function verifyPassword(pin: string, hash: string | null): boolean {
	if (!hash) return false;

	const [salt, hashedPin] = hash.split('.');
	if (!salt || !hashedPin) return false;

	const pinBuffer = crypto.scryptSync(pin, salt, 64);
	const hashedPinBuffer = Buffer.from(hashedPin, 'hex');
	if (pinBuffer.length !== hashedPinBuffer.length) {
		return false;
	}
	return crypto.timingSafeEqual(hashedPinBuffer, pinBuffer);
}

/** Tolerates both `Bearer <jwt>` and a bare token, as the template estate does. */
export function extractJwtFromAuthString(auth: string): string {
	return (auth || '').replace('Bearer', '').trim();
}

/**
 * Guards the one thing a constant-time compare cannot: an account that does not exist
 * returns in microseconds while a real one spends ~80 ms in scrypt, which enumerates
 * valid accounts by stopwatch (TH-08). Verifying against a fixed dummy hash makes the
 * unknown-email path cost the same as the wrong-password path.
 *
 * FR-06 / test A-03 require the two responses to be byte-identical; this makes them
 * indistinguishable in time as well.
 */
export const DUMMY_PASSWORD_HASH = hashPassword('prudentia-timing-equaliser');

export function assertAuthConfigured(): void {
	if (!Constants.AUTH_JWT_KEY) {
		throw new Error('AUTH_JWT_KEY is not set. Refusing to start: every session token would be unverifiable.');
	}
}
