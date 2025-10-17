export interface SabrPlaybackOptions {
	preferWebM?: boolean;
	preferOpus?: boolean;
	videoQuality?: string;
	audioQuality?: string;
	enabledTrackTypes?: any;
}

export interface StreamResult {
	videoStream: ReadableStream;
	audioStream: ReadableStream;
	selectedFormats: {
		videoFormat: any;
		audioFormat: any;
	};
	videoTitle: string;
}

declare module "googlevideo/sabr-stream" {
	export interface SabrPlaybackOptions {
		preferWebM?: boolean;
		preferOpus?: boolean;
		videoQuality?: string;
		audioQuality?: string;
		enabledTrackTypes?: any;
	}

	export interface StreamResult {
		videoStream: ReadableStream;
		audioStream: ReadableStream;
		selectedFormats: {
			videoFormat: any;
			audioFormat: any;
		};
		videoTitle: string;
	}

	export function createSabrStream(videoId: string, options: SabrPlaybackOptions): Promise<{ streamResults: StreamResult }>;
}

declare module "googlevideo/utils" {
	export enum EnabledTrackTypes {
		VIDEO_AND_AUDIO = "VIDEO_AND_AUDIO",
	}
}
