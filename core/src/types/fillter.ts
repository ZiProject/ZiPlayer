/**
 * Audio filter configuration for applying effects to audio streams.
 * Based on FFmpeg audio filters for Discord music bots.
 *
 * @example
 * // Bass boost filter
 * const bassFilter: AudioFilter = {
 *   name: "bassboost",
 *   ffmpegFilter: "bass=g=10:f=110:w=0.5",
 *   description: "Tăng âm trầm"
 * };
 *
 * // Nightcore filter (speed + pitch)
 * const nightcoreFilter: AudioFilter = {
 *   name: "nightcore",
 *   ffmpegFilter: "atempo=1.25,asetrate=44100*1.25",
 *   description: "Tăng tốc độ và cao độ"
 * };
 *
 * // Custom filter
 * const customFilter: AudioFilter = {
 *   name: "custom",
 *   ffmpegFilter: "volume=1.5,treble=g=5",
 *   description: "Tăng âm lượng và âm cao"
 * };
 */
export interface AudioFilter {
	/** Unique name identifier for the filter */
	name: string;
	/** FFmpeg audio filter string */
	ffmpegFilter: string;
	/** Human-readable description of the filter */
	description: string;
	/** Optional category for grouping filters */
	category?: string;
	/** Optional parameters for dynamic filter generation */
	parameters?: Record<string, any>;
}

/**
 * Predefined audio filters commonly used in Discord music bots.
 * These filters are based on popular FFmpeg audio filter combinations.
 */
export const PREDEFINED_FILTERS: Record<string, AudioFilter> = {
	bassboost: {
		name: "bassboost",
		ffmpegFilter: "bass=g=10:f=110:w=0.5",
		description: "Bass Boost",
		category: "eq",
	},
	nightcore: {
		name: "nightcore",
		ffmpegFilter: "aresample=48000,asetrate=48000*1.5",
		description: "Nightcore",
		category: "speed",
	},
	karaoke: {
		name: "karaoke",
		ffmpegFilter: "stereotools=mlev=0.1",
		description: "Karaoke",
		category: "vocal",
	},
	lofi: {
		name: "lofi",
		ffmpegFilter: "aresample=48000,asetrate=48000*0.9,extrastereo=m=2.5:c=disabled",
		description: "Lo-fi",
		category: "speed",
	},
	"8D": {
		name: "8D",
		ffmpegFilter: "apulsator=hz=0.08",
		description: "8D Effect",
		category: "effect",
	},
	vaporwave: {
		name: "vaporwave",
		ffmpegFilter:
			"highpass=f=50, lowpass=f=2750, aresample=48000, asetrate=48000*0.85,bass=g=5:f=110:w=0.6, compand=attacks=0:points=-80/-169|-54/-80|-49.5/-64.6|-41.1/-41.1|-25.8/-15|-10.8/-4.5|0/0|20/8.3",
		description: "Vaporwave",
		category: "speed",
	},
	bathroom: {
		name: "bathroom",
		ffmpegFilter:
			"highpass=f=10, lowpass=f=400, aresample=44100, asetrate=44100*0.85,bass=g=4:f=110:w=0.6, alimiter=1, compand=attacks=0:points=-80/-169|-54/-80|-49.5/-64.6|-41.1/-41.1|-25.8/-15|-10.8/-4.5|0/0|20/8.3",
		description: "Bathroom",
		category: "speed",
	},
	expander: {
		name: "expander",
		ffmpegFilter: "compand=attacks=0:points=-80/-169|-54/-80|-49.5/-64.6|-41.1/-41.1|-25.8/-15|-10.8/-4.5|0/0|20/8.3",
		description: "Expander",
		category: "speed",
	},
	reverse: {
		name: "reverse",
		ffmpegFilter: "areverse",
		description: "Reverse",
		category: "effect",
	},
	echo: {
		name: "echo",
		ffmpegFilter: "aecho=0.8:0.88:60:0.4",
		description: "Echo",
		category: "effect",
	},
	trebleboost: {
		name: "trebleboost",
		ffmpegFilter: "treble=g=10:f=3000:w=0.5",
		description: "Treble Boost",
		category: "eq",
	},

	chorus: {
		name: "chorus",
		ffmpegFilter: "chorus=0.5:0.9:50:0.4:0.25:2",
		description: "Chorus",
		category: "effect",
	},
	flanger: {
		name: "flanger",
		ffmpegFilter: "flanger=delay=10:depth=2:regen=0:width=71:speed=0.5",
		description: "Flanger",
		category: "effect",
	},
	phaser: {
		name: "phaser",
		ffmpegFilter: "aphaser=in_gain=0.4:out_gain=0.74:delay=3.0:decay=0.4:speed=0.5",
		description: "Phaser",
		category: "effect",
	},
	tremolo: {
		name: "tremolo",
		ffmpegFilter: "tremolo=f=4.0:d=0.5",
		description: "Tremolo",
		category: "effect",
	},
	vibrato: {
		name: "vibrato",
		ffmpegFilter: "vibrato=f=5.5:d=0.5",
		description: "Vibrato",
		category: "effect",
	},
	normalize: {
		name: "normalize",
		ffmpegFilter: "loudnorm",
		description: "Normalize",
		category: "volume",
	},
	compressor: {
		name: "compressor",
		ffmpegFilter: "compand=points=-80/-105|-62/-80|-15.4/-15.4|0/-12|20/-7.6",
		description: "Compressor",
		category: "dynamics",
	},
	limiter: {
		name: "limiter",
		ffmpegFilter: "alimiter=level_in=1:level_out=0.8:limit=0.9",
		description: "Limiter",
		category: "dynamics",
	},
	gate: {
		name: "gate",
		ffmpegFilter: "agate=threshold=0.01:ratio=2:attack=1:release=100",
		description: "Gate",
		category: "dynamics",
	},
	lowpass: {
		name: "lowpass",
		ffmpegFilter: "lowpass=f=3000",
		description: "Lowpass",
		category: "filter",
	},
	highpass: {
		name: "highpass",
		ffmpegFilter: "highpass=f=200",
		description: "Highpass",
		category: "filter",
	},
	bandpass: {
		name: "bandpass",
		ffmpegFilter: "bandpass=f=1000:csg=1",
		description: "Bandpass",
		category: "filter",
	},
	allpass: {
		name: "allpass",
		ffmpegFilter: "allpass=f=1000:width_type=h:width=200",
		description: "Allpass",
		category: "filter",
	},
	equalizer: {
		name: "equalizer",
		ffmpegFilter: "equalizer=f=1000:width_type=h:width=200:g=5",
		description: "Equalizer",
		category: "eq",
	},
	reverb: {
		name: "reverb",
		ffmpegFilter: "aecho=0.8:0.88:60:0.4",
		description: "Reverb",
		category: "effect",
	},
	delay: {
		name: "delay",
		ffmpegFilter: "aecho=0.8:0.9:1000:0.3",
		description: "Delay",
		category: "effect",
	},
	distortion: {
		name: "distortion",
		ffmpegFilter: "acrusher=bits=8:mode=log:aa=1",
		description: "Distortion",
		category: "effect",
	},
	bitcrusher: {
		name: "bitcrusher",
		ffmpegFilter: "acrusher=bits=8:mode=log:aa=1",
		description: "Bitcrusher",
		category: "effect",
	},
	robot: {
		name: "robot",
		ffmpegFilter: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
		description: "Robot",
		category: "vocal",
	},
	slow: {
		name: "slow",
		ffmpegFilter: "atempo=0.5",
		description: "Slow",
		category: "speed",
	},
	fast: {
		name: "fast",
		ffmpegFilter: "atempo=2.0",
		description: "Fast",
		category: "speed",
	},
	mono: {
		name: "mono",
		ffmpegFilter: "pan=mono|c0=0.5*c0+0.5*c1",
		description: "Mono",
		category: "channel",
	},
	stereo: {
		name: "stereo",
		ffmpegFilter: "pan=stereo|c0<c0+c1+c2+c3+c4+c5|c1<c0+c1+c2+c3+c4+c5",
		description: "Stereo",
		category: "channel",
	},
	haas: {
		name: "haas",
		ffmpegFilter: "haas",
		description: "Haas",
		category: "dynamics",
	},
	fadein: {
		name: "fadein",
		ffmpegFilter: "afade=t=in:ss=0:d=5",
		description: "Fadein",
		category: "effect",
	},
};
