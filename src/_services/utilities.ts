import path from 'path';

/**
 * The directory the compiled/interpreted source is running from — `src/` under
 * ts-node-dev and jest, `dist/` after a build. Migration and route discovery both
 * resolve against it.
 */
export function getBaseDir(): string {
	return path.join(__dirname, '..');
}

/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * FR-26 requires the synthetic dataset to be reproducible, and the test suite asserts
 * exact figures against it — so `Math.random()` is unusable. This is seeded once in the
 * generator and threaded through every draw.
 *
 * Chosen over an npm PRNG deliberately: it is eight lines, has no supply chain, and a
 * reader can verify by inspection that the same seed yields the same dataset.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function random(): number {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
