export type AudioFrameFormat =
	| {
			kind: "encoded";
			codec?: string;
			container?: string;
	  };
