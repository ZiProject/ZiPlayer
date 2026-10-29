import fs from "node:fs";

export function resolveFfmpegExecutable(explicit?: string | null, bundledPath?: string | null): string {
	const isUsableFile = (candidate: string): boolean => {
		try {
			const stats = fs.statSync(candidate);
			if (!stats.isFile()) return false;
			if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	const candidates = [explicit, process.env.FFMPEG_PATH, bundledPath];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "string" || !candidate.trim()) continue;
		const trimmed = candidate.trim();
		// A bare executable name intentionally resolves through PATH; never inspect cwd or HOME.
		if (trimmed === "ffmpeg" || trimmed === "ffmpeg.exe") return trimmed;
		if (isUsableFile(trimmed)) return trimmed;
		// Respect an explicit path (or environment override) by allowing spawn to report its error.
		if (candidate === explicit || candidate === process.env.FFMPEG_PATH) return trimmed;
	}
	return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

export function sanitizeFfmpegLog(text: string): string {
	return text
		.replace(/[A-Za-z]:\\[^\s]+/g, "[redacted]")
		.replace(/file:\/\/[^\s]+/gi, "[redacted]")
		.replace(/https?:\/\/[^\s]+/gi, "[redacted]")
		.replace(/(^|[\s"'])(\/?(?:home|Users|tmp|var|etc|root|opt)\/[^\s"']+)/g, "$1[redacted]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}
