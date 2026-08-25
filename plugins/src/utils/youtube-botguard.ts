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

function getCachedMinter(): WebPoMinter | undefined {
	const mng = getManager();
	if (!mng) return undefined;

	const cached = mng.cache.get(MINTER_CACHE_KEY) as CachedMinter | undefined;
	return cached?.minter;
}

function setCachedMinter(minter: WebPoMinter): void {
	const mng = getManager();
	if (!mng) return;

	mng.cache.set(MINTER_CACHE_KEY, { minter });
}

function clearCachedMinter(): void {
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
		url: "https://www.youtube.com/",
		referrer: "https://www.youtube.com/",
		userAgent: USER_AGENT,
	});

	const pageResponse = await fetch("https://www.youtube.com", {
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

	// YouTube may change its page HTML, so keep this extraction isolated and
	// fail cleanly so callers can fall back to SABR.
	const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
	if (!ytConfig) throw new Error("Could not find ytcfg in YouTube page HTML");

	(dom.window as any).yt = { config_: JSON.parse(ytConfig) };

	Object.assign(globalThis, {
		yt: (dom.window as any).yt,
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		origin: dom.window.origin,
	});

	if (!("navigator" in globalThis)) {
		Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
	}

	const initialAttestationData = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
	if (!initialAttestationData) throw new Error("Could not find BotGuard challenge in YouTube page HTML");

	const initialAttestationDataJson = parseLooseJSON(initialAttestationData[1]) as any;
	const challengeResponse = initialAttestationDataJson.R;
	if (!challengeResponse?.bgChallenge) throw new Error("Could not get BotGuard challenge");

	const interpreterUrl = challengeResponse.bgChallenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
	if (!interpreterUrl) throw new Error("Could not get BotGuard interpreter URL");

	const bgScriptResponse = await fetch(`https:${interpreterUrl}`);
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

async function getMinter(): Promise<WebPoMinter> {
	const cached = getCachedMinter();
	if (cached) return cached;

	if (!minterPromise) {
		// Do not bind creation to a track AbortSignal: this promise is shared by
		// every plugin/player using the manager cache.
		minterPromise = createMinter().then((minter) => {
			setCachedMinter(minter);
			return minter;
		}).catch((error) => {
			minterPromise = undefined;
			throw error;
		});
	}

	return minterPromise;
}

/**
 * Mint a current WebPO token bound to a YouTube video ID.
 *
 * The WebPoMinter is shared through PlayerManager.cache so multiple
 * YouTubePlugin instances reuse the same BotGuard state. The manager's LRU
 * cache owns eviction; WebPoMinter remains responsible for token lifetime.
 */
export async function mintYouTubePoToken(videoId: string, signal?: AbortSignal): Promise<string> {
	if (!videoId) throw new Error("videoId is required for a WebPO token");
	throwIfAborted(signal);

	const minter = await getMinter();
	throwIfAborted(signal);

	try {
		return await minter.mintAsWebsafeString(videoId);
	} catch (error) {
		// A cached minter can become invalid after YouTube changes its
		// attestation state. Drop it so the next request can rebuild it.
		clearCachedMinter();
		minterPromise = undefined;
		throw error;
	}
}

export function resetYouTubeBotGuard(): void {
	minterPromise = undefined;
	clearCachedMinter();
}
