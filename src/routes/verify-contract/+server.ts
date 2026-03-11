import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ETHERSCAN_API_KEYS, VERIFICATION_SECRET } from '$env/static/private';

// ── Etherscan V2 Unified API ──
// Single API key works across all 60+ chains — just change the chainid parameter.
// Docs: https://docs.etherscan.io/etherscan-v2

const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';

function parseKeys(raw: string | undefined): string[] {
	return raw?.split(',').map((k) => k.trim()).filter(Boolean) ?? [];
}

const apiKeys = parseKeys(ETHERSCAN_API_KEYS);
let keyCounter = 0;

function getNextApiKey(): string {
	if (apiKeys.length === 0) {
		throw new Error('No ETHERSCAN_API_KEYS configured');
	}
	const key = apiKeys[keyCounter % apiKeys.length];
	keyCounter++;
	return key;
}

// ── Types ──

interface VerifyRequest {
	chainId: number;
	contractAddress: string;
	/** Fully qualified: "contracts/tokenKrafter-v1.sol:TokenFactory" */
	contractName: string;
	/** ABI-encoded constructor arguments (hex string, no 0x prefix) */
	constructorArgs?: string;
	/** Library name -> deployed address mapping */
	libraries?: Record<string, string>;
	/** Solidity standard JSON input (from Hardhat build-info) */
	standardJsonInput: object;
}

// ── POST: Submit verification ──

export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (VERIFICATION_SECRET && authHeader !== `Bearer ${VERIFICATION_SECRET}`) {
		return json({ success: false, message: 'Unauthorized' }, { status: 401 });
	}

	let body: VerifyRequest;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, message: 'Invalid JSON body' }, { status: 400 });
	}

	const { chainId, contractAddress, contractName, constructorArgs, libraries, standardJsonInput } =
		body;

	if (!chainId || !contractAddress || !contractName || !standardJsonInput) {
		return json(
			{
				success: false,
				message:
					'Missing required fields: chainId, contractAddress, contractName, standardJsonInput'
			},
			{ status: 400 }
		);
	}

	try {
		const apiKey = getNextApiKey();

		const formData = new URLSearchParams({
			chainid: String(chainId),
			apikey: apiKey,
			module: 'contract',
			action: 'verifysourcecode',
			contractaddress: contractAddress,
			sourceCode: JSON.stringify(standardJsonInput),
			codeformat: 'solidity-standard-json-input',
			contractname: contractName,
			compilerversion: 'v0.8.20+commit.a1b79de6',
			optimizationUsed: '1',
			runs: '200',
			constructorArguements: constructorArgs ?? '', // Etherscan intentional typo
			evmversion: 'paris',
			licenseType: '3' // MIT
		});

		// Add library addresses if provided
		if (libraries) {
			let idx = 1;
			for (const [name, addr] of Object.entries(libraries)) {
				formData.set(`libraryname${idx}`, name);
				formData.set(`libraryaddress${idx}`, addr);
				idx++;
			}
		}

		const resp = await fetch(ETHERSCAN_V2_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formData.toString()
		});

		const data = await resp.json();

		if (data.status === '1') {
			return json({ success: true, message: 'Verification submitted', guid: data.result });
		}

		if (data.result?.toLowerCase().includes('already verified')) {
			return json({ success: true, message: 'Already verified' });
		}

		return json({ success: false, message: data.result || 'Unknown error' });
	} catch (err: any) {
		return json(
			{ success: false, message: err.message || 'Verification request failed' },
			{ status: 500 }
		);
	}
};

// ── GET: Check verification status ──

export const GET: RequestHandler = async ({ url }) => {
	const chainId = Number(url.searchParams.get('chainId'));
	const guid = url.searchParams.get('guid');

	if (!chainId || !guid) {
		return json(
			{ success: false, message: 'Missing chainId or guid query params' },
			{ status: 400 }
		);
	}

	try {
		const apiKey = getNextApiKey();
		const params = new URLSearchParams({
			chainid: String(chainId),
			apikey: apiKey,
			module: 'contract',
			action: 'checkverifystatus',
			guid
		});

		const resp = await fetch(`${ETHERSCAN_V2_URL}?${params}`);
		const data = await resp.json();

		return json({
			success: data.status === '1',
			message: data.result
		});
	} catch (err: any) {
		return json({ success: false, message: err.message }, { status: 500 });
	}
};
