import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

const MAX_REDIRECTS = 5;
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata.google.com", "instance-data"]);

export class UnsafeMediaUrlError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "UnsafeMediaUrlError";
	}
}

function ipv4ToInt(address: string): number | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d+$/.test(part)) return null;
		const octet = Number(part);
		if (octet < 0 || octet > 255) return null;
		value = (value << 8) + octet;
	}
	return value >>> 0;
}

function isBlockedIPv4(address: string): boolean {
	const value = ipv4ToInt(address);
	if (value === null) return true;
	if (value === 0) return true;
	if ((value & 0xff000000) === 0x7f000000) return true; // 127.0.0.0/8
	if ((value & 0xff000000) === 0x0a000000) return true; // 10.0.0.0/8
	if ((value & 0xfff00000) === 0xac100000) return true; // 172.16.0.0/12
	if ((value & 0xffff0000) === 0xc0a80000) return true; // 192.168.0.0/16
	if ((value & 0xffff0000) === 0xa9fe0000) return true; // 169.254.0.0/16
	if ((value & 0xf0000000) === 0xe0000000) return true; // multicast
	if ((value & 0xffffffff) === 0xffffffff) return true; // broadcast
	return false;
}

function extractMappedIPv4(address: string): string | null {
	const lowered = address.toLowerCase();
	if (lowered.startsWith("::ffff:")) {
		const mapped = lowered.slice("::ffff:".length);
		return ipv4ToInt(mapped) === null ? null : mapped;
	}
	return null;
}

function isBlockedIPv6(address: string): boolean {
	const lowered = address.toLowerCase();
	if (lowered === "::" || lowered === "::1") return true;
	const mapped = extractMappedIPv4(lowered);
	if (mapped) return isBlockedIPv4(mapped);
	const normalized = lowered.includes(":") ? lowered : "";
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
	if (normalized.startsWith("fe80")) return true; // link-local
	if (normalized.startsWith("ff")) return true; // multicast
	return false;
}

export function isBlockedIpAddress(address: string): boolean {
	if (address.includes(":")) return isBlockedIPv6(address);
	return isBlockedIPv4(address);
}

export async function resolvePublicAddresses(hostname: string): Promise<string[]> {
	const results = await lookup(hostname, { all: true, verbatim: true });
	if (!results.length) throw new UnsafeMediaUrlError("Media URL hostname did not resolve");
	const addresses = results.map((entry) => entry.address);
	for (const address of addresses) {
		if (isBlockedIpAddress(address)) {
			throw new UnsafeMediaUrlError("Media URL resolves to a blocked address");
		}
	}
	return addresses;
}

export function parseMediaUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new UnsafeMediaUrlError("Media URL is not a valid absolute URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UnsafeMediaUrlError("Media URL must use http or https");
	}
	if (parsed.username || parsed.password) {
		throw new UnsafeMediaUrlError("Media URL must not include userinfo");
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!hostname) throw new UnsafeMediaUrlError("Media URL is missing a hostname");
	if (BLOCKED_HOSTS.has(hostname)) throw new UnsafeMediaUrlError("Media URL hostname is blocked");
	if (isBlockedIpAddress(hostname)) throw new UnsafeMediaUrlError("Media URL host is a blocked address");
	return parsed;
}

export async function assertSafeMediaUrl(raw: string): Promise<URL> {
	const parsed = parseMediaUrl(raw);
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	if (!isBlockedIpAddress(hostname)) await resolvePublicAddresses(hostname);
	return parsed;
}

function requestOnce(url: URL, address: string, signal?: AbortSignal): Promise<IncomingMessage> {
	const transport = url.protocol === "https:" ? https : http;
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const isIPv6 = address.includes(":");
	return new Promise((resolve, reject) => {
		const req = transport.request(
			{
				host: isIPv6 ? address : address,
				hostname: address,
				servername: hostname,
				port: url.port || (url.protocol === "https:" ? 443 : 80),
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers: { Host: url.host, "User-Agent": "ZiPlayer" },
				setHost: false,
				signal,
			},
			(response) => resolve(response),
		);
		req.on("error", reject);
		req.end();
	});
}

export async function openSafeHttpStream(raw: string, signal?: AbortSignal, redirects = 0): Promise<Readable> {
	if (redirects > MAX_REDIRECTS) throw new UnsafeMediaUrlError("Media URL exceeded redirect limit");
	const parsed = parseMediaUrl(raw);
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	const addresses = isBlockedIpAddress(hostname) ? [hostname] : await resolvePublicAddresses(hostname);
	const response = await requestOnce(parsed, addresses[0], signal);
	const status = response.statusCode ?? 0;
	if (status >= 300 && status < 400) {
		response.resume();
		const location = response.headers.location;
		if (!location) throw new UnsafeMediaUrlError("Media URL redirect is missing a Location header");
		const next = new URL(location, parsed);
		return openSafeHttpStream(next.toString(), signal, redirects + 1);
	}
	if (status >= 400) {
		response.resume();
		throw new UnsafeMediaUrlError(`Media URL responded with HTTP ${status}`);
	}
	return response;
}
