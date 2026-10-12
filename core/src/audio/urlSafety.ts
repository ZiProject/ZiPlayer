import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
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
		value = (value * 256 + octet) >>> 0;
	}
	return value >>> 0;
}

function inV4Cidr(value: number, network: number, mask: number): boolean {
	return ((value & mask) >>> 0) === (network >>> 0);
}

function isBlockedIPv4(address: string): boolean {
	const value = ipv4ToInt(address);
	if (value === null) return false;
	return (
		inV4Cidr(value, 0x00000000, 0xff000000) || // 0.0.0.0/8
		inV4Cidr(value, 0x0a000000, 0xff000000) || // 10.0.0.0/8
		inV4Cidr(value, 0x64400000, 0xffc00000) || // CGNAT 100.64.0.0/10
		inV4Cidr(value, 0x7f000000, 0xff000000) || // loopback
		inV4Cidr(value, 0xa9fe0000, 0xffff0000) || // link-local / cloud metadata
		inV4Cidr(value, 0xac100000, 0xfff00000) || // 172.16.0.0/12
		inV4Cidr(value, 0xc0000000, 0xffffff00) || // 192.0.0.0/24
		inV4Cidr(value, 0xc0000200, 0xffffff00) || // TEST-NET-1
		inV4Cidr(value, 0xc0a80000, 0xffff0000) || // private 192.168/16
		inV4Cidr(value, 0xc6120000, 0xfffe0000) || // benchmarking 198.18.0.0/15
		inV4Cidr(value, 0xc6336400, 0xffffff00) || // TEST-NET-2
		inV4Cidr(value, 0xcb007100, 0xffffff00) || // TEST-NET-3
		inV4Cidr(value, 0xe0000000, 0xf0000000) || // multicast / reserved
		inV4Cidr(value, 0xf0000000, 0xf0000000) || // reserved / future use
		value === 0xffffffff // limited broadcast
	);
}

function parseIPv6Words(address: string): number[] | null {
	let value = address.toLowerCase().split("%", 1)[0];
	if (value.includes(".")) {
		const lastColon = value.lastIndexOf(":");
		const ipv4 = ipv4ToInt(value.slice(lastColon + 1));
		if (ipv4 === null) return null;
		value = `${value.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
	}
	if (!value.includes(":")) return null;
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const parse = (parts: string[]) => parts.map((part) => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : -1);
	const lhs = parse(left);
	const rhs = parse(right);
	if ([...lhs, ...rhs].some((word) => word < 0)) return null;
	const missing = 8 - lhs.length - rhs.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
	return [...lhs, ...Array.from({ length: missing }, () => 0), ...rhs];
}

function isBlockedIPv6(address: string): boolean {
	const words = parseIPv6Words(address);
	if (!words) return false;
	if (words.every((word) => word === 0)) return true; // ::
	if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true; // ::1
	if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
		const v4 = `${words[6] >>> 8}.${words[6] & 0xff}.${words[7] >>> 8}.${words[7] & 0xff}`;
		return isBlockedIPv4(v4); // IPv4-mapped IPv6, including hexadecimal tails
	}
	if ((words[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
	if ((words[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	if ((words[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
	if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) return true; // NAT64 well-known prefix
	if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001) return true; // local-use NAT64
	if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // documentation 2001:db8::/32
	return false;
}

export function isBlockedIpAddress(address: string): boolean {
	const normalized = address.replace(/^\[|\]$/g, "");
	const version = isIP(normalized);
	if (version === 4) return isBlockedIPv4(normalized);
	if (version === 6) return isBlockedIPv6(normalized);
	return false; // Domain names are not IP literals and must be DNS-resolved instead.
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
	const version = isIP(hostname);
	if (version !== 0) {
		if (isBlockedIpAddress(hostname)) throw new UnsafeMediaUrlError("Media URL host is a blocked address");
	} else {
		await resolvePublicAddresses(hostname);
	}
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
	const version = isIP(hostname);
	const addresses = version !== 0 ? [hostname] : await resolvePublicAddresses(hostname);
	if (addresses.some(isBlockedIpAddress)) throw new UnsafeMediaUrlError("Media URL resolves to a blocked address");
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
