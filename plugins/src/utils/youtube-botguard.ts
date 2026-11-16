import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders, parseLooseJSON, USER_AGENT } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { JSDOM } from "jsdom";
import { getManager } from "ziplayer";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const MINTER_CACHE_KEY = "youtube:botguard:minter";

type CachedMinter = {
	minter: WebPoMinter;
};

let fallbackCachedMinter: WebPoMinter | undefined;

function getCachedMinter(): WebPoMinter | undefined {
	const mng = getManager();
	if (mng) {
		const cached = mng.cache.get(MINTER_CACHE_KEY) as CachedMinter | undefined;
		if (cached?.minter) return cached.minter;
	}
	return fallbackCachedMinter;
}

function setCachedMinter(minter: WebPoMinter): void {
	fallbackCachedMinter = minter;
	const mng = getManager();
	if (!mng) return;
	mng.cache.set(MINTER_CACHE_KEY, { minter });
}

function clearCachedMinter(): void {
	fallbackCachedMinter = undefined;
	const mng = getManager();
	if (!mng) return;
	mng.cache.delete(MINTER_CACHE_KEY);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function createMinter(): Promise<WebPoMinter> {
	const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
		url: "https://www.youtube.com",
		referrer: "https://www.youtube.com/",
		userAgent: USER_AGENT,
	});

	const pageResponse = await fetch("https://www.youtube.com", {
		signal: AbortSignal.timeout(15_000),
		headers: {
			accept: "*/*",
			"accept-language": "en-US,en;q=0.7",
			"user-agent": USER_AGENT,
		},
	});

	if (!pageResponse.ok) {
		throw new Error(`Failed to load YouTube page: HTTP ${pageResponse.status}`);
	}

	const pageHtml = await pageResponse.text();

	const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
	if (!ytConfig) throw new Error("Could not find ytcfg in YouTube page HTML");

	(dom.window as any).yt = { config_: JSON.parse(ytConfig) };

	// Canvas 2d context stub to prevent BotGuard VM from throwing in headless environments
	(dom.window as any).HTMLCanvasElement.prototype.getContext = function (contextId: string) {
		if (contextId !== "2d") return null;
		return {
			fillRect: () => {},
			clearRect: () => {},
			getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
			putImageData: () => {},
			createImageData: () => [],
			setTransform: () => {},
			drawImage: () => {},
			save: () => {},
			fillText: () => {},
			restore: () => {},
			beginPath: () => {},
			moveTo: () => {},
			lineTo: () => {},
			closePath: () => {},
			stroke: () => {},
			translate: () => {},
			scale: () => {},
			rotate: () => {},
			arc: () => {},
			fill: () => {},
			measureText: () => ({ width: 0 }),
			transform: () => {},
			rect: () => {},
			clip: () => {},
		};
	} as any;

	Object.assign(globalThis, {
		yt: (dom.window as any).yt,
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		origin: dom.window.origin,
	});

	// Override navigator on globalThis (Node.js 21+ has built-in read-only navigator by default)
	try {
		Object.defineProperty(globalThis, "navigator", {
			value: dom.window.navigator,
			configurable: true,
			writable: true,
		});
	} catch {
		// Ignore if non-configurable
	}

	const initialAttestationData = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
	if (!initialAttestationData) throw new Error("Could not find BotGuard challenge in YouTube page HTML");

	const initialAttestationDataJson = parseLooseJSON(initialAttestationData[1]) as any;
	const challengeResponse = initialAttestationDataJson.R;
	if (!challengeResponse?.bgChallenge) throw new Error("Could not get BotGuard challenge");

	const interpreterUrl = challengeResponse.bgChallenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
	if (!interpreterUrl) throw new Error("Could not get BotGuard interpreter URL");

	const bgScriptResponse = await fetch(`https:${interpreterUrl}`, { signal: AbortSignal.timeout(15_000) });
	if (!bgScriptResponse.ok) {
		throw new Error(`Failed to load BotGuard interpreter: HTTP ${bgScriptResponse.status}`);
	}

	const interpreterJavascript = await bgScriptResponse.text();
	if (!interpreterJavascript) throw new Error("Could not load BotGuard interpreter");

	new Function(interpreterJavascript)();

	const botGuardClient = await BotGuardClient.create({
		program: challengeResponse.bgChallenge.program,
		globalName: challengeResponse.bgChallenge.globalName,
		globalObject: globalThis,
	});

	const webPoSignalOutput: WebPoSignalOutput = [];
	const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

	const integrityTokenResponse = await fetch(buildURL("GenerateIT", true), {
		signal: AbortSignal.timeout(15_000),
		method: "POST",
		headers: getHeaders(),
		body: JSON.stringify([REQUEST_KEY, botguardResponse]),
	});

	if (!integrityTokenResponse.ok) {
		throw new Error(`GenerateIT failed: HTTP ${integrityTokenResponse.status}`);
	}

	const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
		(await integrityTokenResponse.json()) as [string, number, number, string];

	if (!integrityToken) throw new Error("GenerateIT returned an empty integrity token");

	return WebPoMinter.create(
		{
			integrityToken,
			estimatedTtlSecs,
			mintRefreshThreshold,
			websafeFallbackToken,
		},
		webPoSignalOutput,
	);
}

let minterPromise: Promise<WebPoMinter> | undefined;

export async function getYouTubeWebPoMinter(signal?: AbortSignal): Promise<WebPoMinter> {
	throwIfAborted(signal);
	const cached = getCachedMinter();
	if (cached) return cached;

	if (!minterPromise) {
		minterPromise = createMinter()
			.then((minter) => {
				setCachedMinter(minter);
				return minter;
			})
			.catch((error) => {
				minterPromise = undefined;
				throw error;
			});
	}

	return minterPromise;
}

/**
 * Mint a WebPO token string bound to a YouTube video ID (base64url websafe string).
 */
export async function mintYouTubePoToken(videoId: string, signal?: AbortSignal): Promise<string> {
	if (!videoId) throw new Error("videoId is required for a WebPO token");
	throwIfAborted(signal);

	const minter = await getYouTubeWebPoMinter(signal);
	throwIfAborted(signal);

	try {
		return await minter.mintAsWebsafeString(videoId);
	} catch (error) {
		clearCachedMinter();
		minterPromise = undefined;
		throw error;
	}
}

/**
 * Mint a WebPO token as binary Uint8Array bytes bound to a YouTube video ID (for SABR/UMP callbacks).
 */
export async function mintYouTubePoTokenBytes(videoId: string, signal?: AbortSignal): Promise<Uint8Array> {
	if (!videoId) throw new Error("videoId is required for a WebPO token");
	throwIfAborted(signal);

	const minter = await getYouTubeWebPoMinter(signal);
	throwIfAborted(signal);

	try {
		return await minter.mint(videoId);
	} catch (error) {
		clearCachedMinter();
		minterPromise = undefined;
		throw error;
	}
}

export function resetYouTubeBotGuard(): void {
	minterPromise = undefined;
	clearCachedMinter();
}
