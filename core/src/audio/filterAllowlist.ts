/**
 * Allowlist parser for FFmpeg audio filter graphs supplied as custom strings.
 * Predefined filters in `PREDEFINED_FILTERS` are trusted by name and are not required to pass this parser
 * (some bundled graphs use quotes that custom strings are not allowed to contain).
 */

export const ALLOWED_FFMPEG_AUDIO_FILTERS: ReadonlySet<string> = new Set([
	"bass",
	"treble",
	"equalizer",
	"volume",
	"aecho",
	"atempo",
	"asetrate",
	"tremolo",
	"vibrato",
	"loudnorm",
	"highpass",
	"lowpass",
	"aresample",
	"stereotools",
	"extrastereo",
	"apulsator",
	"compand",
	"alimiter",
	"agate",
	"areverse",
	"chorus",
	"flanger",
	"aphaser",
	"bandpass",
	"allpass",
	"acrusher",
	"afftfilt",
	"pan",
	"haas",
	"afade",
]);

const MAX_CUSTOM_FILTER_LENGTH = 1000;
const FORBIDDEN_CHARS = /[\\'"\u0000-\u001f]/;

export function isSafeCustomFilter(filter: string): boolean {
	if (!filter || filter.length > MAX_CUSTOM_FILTER_LENGTH) return false;
	if (FORBIDDEN_CHARS.test(filter)) return false;
	const names = parseFilterNames(filter);
	return names !== null && names.length > 0 && names.every((name) => ALLOWED_FFMPEG_AUDIO_FILTERS.has(name));
}

/**
 * Extracts lowercase filter names from a linear/labeled FFmpeg audio graph.
 * Returns `null` when the graph cannot be parsed (unbalanced pads, empty names, leftover junk).
 */
export function parseFilterNames(graph: string): string[] | null {
	const names: string[] = [];
	let i = 0;
	const end = graph.length;

	const skipWs = () => {
		while (i < end && (graph[i] === " " || graph[i] === "\t")) i++;
	};

	const readPad = (): boolean => {
		if (graph[i] !== "[") return true;
		i++;
		while (i < end && graph[i] !== "]") {
			const ch = graph[i];
			if (ch === "[" || ch === ";" || ch === "," || ch === "\\" || ch === "'" || ch === '"') return false;
			i++;
		}
		if (i >= end || graph[i] !== "]") return false;
		i++;
		return true;
	};

	const readName = (): string | null => {
		skipWs();
		const start = i;
		if (i >= end || !/[A-Za-z]/.test(graph[i])) return null;
		i++;
		while (i < end && /[A-Za-z0-9_]/.test(graph[i])) i++;
		return graph.slice(start, i).toLowerCase();
	};

	while (i < end) {
		skipWs();
		if (i >= end) break;
		while (graph[i] === "[") {
			if (!readPad()) return null;
			skipWs();
		}
		const name = readName();
		if (!name) return null;
		names.push(name);
		skipWs();
		if (i < end && graph[i] === "=") {
			i++;
			while (i < end && graph[i] !== "," && graph[i] !== ";" && graph[i] !== "[") i++;
		}
		skipWs();
		while (i < end && graph[i] === "[") {
			if (!readPad()) return null;
			skipWs();
		}
		skipWs();
		if (i >= end) break;
		if (graph[i] === "," || graph[i] === ";") {
			i++;
			continue;
		}
		return null;
	}

	return names;
}

export function filterGraphContainsLoudnorm(filterString: string | undefined): boolean {
	if (!filterString) return false;
	const names = parseFilterNames(filterString);
	return Boolean(names?.includes("loudnorm"));
}
