/**
 * Fixed reference data for the synthetic dataset (FR-26).
 *
 * Kept separate from the generator so the two can be reasoned about independently: this
 * file is the world the portfolio sits in, the generator is the portfolio.
 */

export interface RegionSeed {
	name: string;
	zone: 'NORTHERN' | 'MIDDLE' | 'COASTAL';
	/** Share of the customer base. Weighted by population; sums to 1. */
	weight: number;
}

/**
 * Ten Ghanaian administrative regions across three zones (docs §5.4).
 *
 * The zone split matters more than the region list: P1 plants a deteriorating loss
 * ratio in the NORTHERN zone, and the three northern regions together hold only ~14% of
 * customers. That thin base is exactly why P1's ramp has to be steep — see the note in
 * the generator.
 */
export const REGIONS: RegionSeed[] = [
	{name: 'Greater Accra', zone: 'COASTAL', weight: 0.2},
	{name: 'Western', zone: 'COASTAL', weight: 0.1},
	{name: 'Central', zone: 'COASTAL', weight: 0.09},
	{name: 'Volta', zone: 'COASTAL', weight: 0.08},
	{name: 'Ashanti', zone: 'MIDDLE', weight: 0.19},
	{name: 'Eastern', zone: 'MIDDLE', weight: 0.11},
	{name: 'Brong Ahafo', zone: 'MIDDLE', weight: 0.09},
	{name: 'Northern', zone: 'NORTHERN', weight: 0.1},
	{name: 'Upper East', zone: 'NORTHERN', weight: 0.024},
	{name: 'Upper West', zone: 'NORTHERN', weight: 0.016}
];

export const VEHICLE_MAKES: Record<string, string[]> = {
	Toyota: ['Corolla', 'Camry', 'Hilux', 'Land Cruiser', 'RAV4', 'Hiace'],
	Nissan: ['Sunny', 'Navara', 'X-Trail', 'Patrol', 'Urvan'],
	Hyundai: ['Elantra', 'Tucson', 'Santa Fe', 'H100', 'Accent'],
	Kia: ['Rio', 'Sportage', 'Sorento', 'K2700'],
	Ford: ['Ranger', 'Everest', 'Transit'],
	Mitsubishi: ['Lancer', 'Pajero', 'L200', 'Canter'],
	Honda: ['Civic', 'Accord', 'CR-V'],
	Suzuki: ['Alto', 'Swift', 'Vitara'],
	Yamaha: ['YBR 125', 'Crux', 'FZ'],
	Mercedes: ['Sprinter', 'Actros', 'C-Class']
};

/** Which makes plausibly supply which category, so the data reads as real. */
export const CATEGORY_MAKES: Record<string, string[]> = {
	SEDAN: ['Toyota', 'Nissan', 'Hyundai', 'Kia', 'Honda', 'Suzuki', 'Mitsubishi', 'Mercedes'],
	SUV: ['Toyota', 'Nissan', 'Hyundai', 'Kia', 'Ford', 'Mitsubishi', 'Honda', 'Suzuki'],
	PICKUP: ['Toyota', 'Nissan', 'Ford', 'Mitsubishi', 'Kia'],
	MOTORCYCLE: ['Yamaha', 'Suzuki', 'Honda'],
	BUS: ['Toyota', 'Nissan', 'Mercedes', 'Hyundai'],
	TRUCK: ['Mitsubishi', 'Mercedes', 'Hyundai', 'Kia']
};

/** Vehicle value bands in GHS, by category. */
export const VALUE_BANDS: Record<string, [number, number]> = {
	MOTORCYCLE: [8000, 26000],
	SEDAN: [35000, 125000],
	SUV: [95000, 360000],
	PICKUP: [85000, 290000],
	BUS: [120000, 420000],
	TRUCK: [150000, 520000]
};

export const ENGINE_BANDS: Record<string, [number, number]> = {
	MOTORCYCLE: [100, 250],
	SEDAN: [1300, 2500],
	SUV: [1800, 4000],
	PICKUP: [2000, 3200],
	BUS: [2200, 4200],
	TRUCK: [3000, 7500]
};

/** Category mix of the book. Sums to 1. */
export const CATEGORY_MIX: Array<[string, number]> = [
	['SEDAN', 0.42],
	['SUV', 0.18],
	['PICKUP', 0.16],
	['MOTORCYCLE', 0.14],
	['BUS', 0.06],
	['TRUCK', 0.04]
];

export const PRODUCT_MIX: Array<[string, number]> = [
	['COMPREHENSIVE', 0.45],
	['THIRD_PARTY', 0.35],
	['THIRD_PARTY_FIRE_THEFT', 0.2]
];

export const CHANNEL_MIX: Array<[string, number]> = [
	['DIRECT', 0.34],
	['BROKER', 0.31],
	['AGENT', 0.26],
	['BANCASSURANCE', 0.09]
];

export const SEGMENT_MIX: Array<[string, number]> = [
	['RETAIL', 0.62],
	['SME', 0.22],
	['CORPORATE', 0.11],
	['FLEET', 0.05]
];

export const CAUSE_MIX: Array<[string, number]> = [
	['ACCIDENT', 0.52],
	['THIRD_PARTY', 0.17],
	['THEFT', 0.12],
	['FLOOD', 0.09],
	['FIRE', 0.06],
	['VANDALISM', 0.04]
];

export const PAYMENT_METHOD_MIX: Array<[string, number]> = [
	['MOBILE_MONEY', 0.41],
	['BANK_TRANSFER', 0.24],
	['CARD', 0.16],
	['CASH', 0.13],
	['CHEQUE', 0.06]
];

export const GARAGE_PREFIXES = [
	'Adom',
	'Bekwai',
	'Cape',
	'Dansoman',
	'Efua',
	'Frafra',
	'Gyamfi',
	'Hohoe',
	' Intercity',
	'Jubilee',
	'Kaneshie',
	'Labone',
	'Mampong',
	'Nsawam',
	'Osu',
	'Prampram',
	'Quarshie',
	'Ridge',
	'Suame',
	'Tema'
];

export const GARAGE_SUFFIXES = ['Auto Works', 'Motors', 'Panel Beaters', 'Service Centre', 'Garage', 'Autobody'];

/**
 * P2 — the three outlier garages. Named here rather than chosen at random so the signal
 * is verifiable by name in a reference query and stable across regenerations.
 */
export const OUTLIER_GARAGE_NAMES = ['Suame Autobody', 'Kaneshie Panel Beaters', 'Tema Motors'];
