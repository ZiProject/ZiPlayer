import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders, parseLooseJSON, USER_AGENT } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { JSDOM } from "jsdom";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";

let minterPromise: Promise<WebPoMinter> | undefined;

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function createMinter(signal?: AbortSignal): Promise<WebPoMinter> {
	throwIfAborted(signal);

	const dom = new JSDOM("<!DOCTYPE html><html lang=\"en\"><head><title></title></head><body></body></html>", {
		url: "https://www.youtube.com/",
		referrer: "https://www.youtube.com/",
		userAgent: USER_AGENT,
	});

	const pageResponse = await fetch("https://www.youtube.com", {
		signal,
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
	throwIfAborted(signal);

	const ytConfig = pageHtml.match(/ytcfg\\.set\\(({.+?})\\);/s)?.[1];
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

	const initialAttestationData = pageHtml.match(/window\\.ytAtN\\(\\s*({[\\s\\S]*?})\\s*\\)/);
	if (!initialAttestationData) throw new Error("Could not find BotGuard challenge in YouTube page HTML");

	const initialAttestationDataJson = parseLooseJSON(initialAttestationData[1]) as any;
	const challengeResponse = initialAttestationDataJson.R;
	if (!challengeResponse?.bgChallenge) throw new Error("Could not get BotGuard challenge");

	const interpreterUrl =
		challengeResponse.bgChallenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
	if (!interpreterUrl) throw new Error("Could not get BotGuard interpreter URL");

	const bgScriptResponse = await fetch(`https:${interpreterUrl}`, { signal });
	if (!bgScriptResponse.ok) {
		throw new Error(`Failed to load BotGuard interpreter: HTTP ${bgScriptResponse.status}`);
	}

	const interpreterJavascript = await bgScriptResponse.text();
	throwIfAborted(signal);

	if (!interpreterJavascript) throw new Error("Could not load BotGuard interpreter");

	new Function(interpreterJavascript)();

	const botGuardClient = await BotGuardClient.create({
		program: challengeResponse.bgChallenge.program,
		globalName: challengeResponse.bgChallenge.globalName,
		globalObject: globalThis,
	});

	const webPoSignalOutput: WebPoSignalOutput = [];
	const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });
	throwIfAborted(signal);

	const integrityTokenResponse = await fetch(buildURL("GenerateIT", true), {
		method: "POST",
		headers: getHeaders(),
		signal,
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

/**
 * Mint a current WebPO token bound to a YouTube video ID.
 *
 * The BotGuard challenge/interpreter and WebPO minter are initialized once
 * and reused. WebPoMinter handles the lifetime/refresh information returned
 * by GenerateIT.
 */
export async function mintYouTubePoToken(videoId: string, signal?: AbortSignal): Promise<string> {
	if (!videoId) throw new Error("videoId is required for a WebPO token");
	throwIfAborted(signal);

	if (!minterPromise) {
		minterPromise = createMinter(signal).catch((error) => {
			minterPromise = undefined;
			throw error;
		});
	}

	const minter = await minterPromise;
	throwIfAborted(signal);
	return minter.mintAsWebsafeString(videoId);
}

export function resetYouTubeBotGuard(): void {
	minterPromise = undefined;
}
