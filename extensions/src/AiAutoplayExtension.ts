import { BaseExtension } from "ziplayer";
import type { ExtensionContext, Player, Track, SearchResult } from "ziplayer";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

/**
 * AiAutoplayExtension - Một Extension sử dụng Gemini 2.5 Flash để phân tích gu âm nhạc
 * và chuẩn bị các gợi ý bài hát tiếp theo một cách thông minh.
 */
export class AiAutoplayExtension extends BaseExtension {
	public name = "AiAutoplayExtension";
	public version = "1.1.0";
	public priority = 100;
	public player: Player | null = null;

	private readonly playerStates = new Map<Player, { history: Track[]; isAnalyzing: boolean; unsubscribe: () => void }>();
	private genAI: GoogleGenerativeAI | null = null;

	constructor(apiKey?: string) {
		super();
		const key = apiKey || process.env.GEMINI_API_KEY;
		if (key) {
			this.genAI = new GoogleGenerativeAI(key);
		}
	}

	/**
	 * Kích hoạt Extension
	 */
	public active(context: ExtensionContext): boolean {
		if (!this.genAI) {
			console.warn("[AiAutoplayExtension] Gemini API Key không tìm thấy. AI sẽ không hoạt động.");
		}
		const player = context.player;
		if (!player) return false;

		this.player = player;
		if (this.playerStates.has(player)) return true;
		const state = { history: [] as Track[], isAnalyzing: false, unsubscribe: () => {} };
		this.playerStates.set(player, state);
		state.unsubscribe = player.bus.subscribe(player.playerId, "TRACK_STARTED", ({ track }) => {
			if (!track) return;
			if (state.history.length === 0 || state.history[state.history.length - 1].url !== track.url) {
				state.history.push(track);
				if (state.history.length > 10) state.history.shift();
			}
			if (this.genAI && state.history.length >= 2 && !state.isAnalyzing) {
				void this.analyzeMusicTaste(context, state);
			}
		});

		return true;
	}

	public onDestroy(context: ExtensionContext): void {
		if (!context.player) return;
		this.playerStates.get(context.player)?.unsubscribe();
		this.playerStates.delete(context.player);
		if (this.player === context.player) this.player = this.playerStates.keys().next().value ?? null;
	}

	private async analyzeMusicTaste(
		context: ExtensionContext,
		state: { history: Track[]; isAnalyzing: boolean; unsubscribe: () => void },
	): Promise<void> {
		const player = context.player;
		const manager = context.manager;
		if (!this.genAI || !player || !manager || !player.autoPlay()) return;
		state.isAnalyzing = true;

		try {
			const model = this.genAI.getGenerativeModel({
				model: "gemini-2.5-flash",
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: {
						type: SchemaType.OBJECT,
						properties: {
							analysis: { type: SchemaType.STRING, description: "Chuỗi phân tích ngắn gọn về gu, tâm trạng" },
							suggestion: { type: SchemaType.STRING, description: "Tên bài hát - Tên nghệ sĩ xuất sắc tiếp theo" },
							reason: { type: SchemaType.STRING, description: "Lý do ngắn gọn gợi ý bài này" },
						},
						required: ["analysis", "suggestion", "reason"],
					},
				},
			});

			const historyText = state.history.map((t, i) => `${i + 1}. ${t.title} - ${t.author}`).join("\n");

			const prompt = `
                Bạn là một chuyên gia âm nhạc AI. Dựa trên lịch sử nghe nhạc gần đây của người dùng dưới đây:
                ${historyText}

                Hãy phân tích gu âm nhạc hiện tại (thể loại, tâm trạng, nhịp điệu).
                Sau đó, hãy gợi ý MỘT bài hát duy nhất phù hợp nhất để phát tiếp theo.
                ⚠️ LƯU Ý: Tuyệt đối KHÔNG ĐƯỢC gợi ý lại bất kỳ bài hát nào đã xuất hiện trong danh sách lịch sử trên.
            `;

			const result = await model.generateContent(prompt);
			if (this.playerStates.get(player) !== state) return;
			const response = await result.response;
			const text = response.text();

			const jsonMatch = text.match(/\{.*\}/s);
			if (!jsonMatch) throw new Error("AI không trả về JSON hợp lệ");

			const aiData = JSON.parse(jsonMatch[0]);
			if (typeof aiData?.suggestion !== "string" || !aiData.suggestion.trim()) {
				throw new Error("AI không trả về gợi ý bài hát hợp lệ");
			}
			player.emit("AiAutoplay", `[AI Autoplay] Gemini phân tích: ${aiData.analysis}`);
			player.emit("AiAutoplay", `[AI Autoplay] Gợi ý bài tiếp theo: ${aiData.suggestion} (${aiData.reason})`);

			const searchResult = await manager.search(aiData.suggestion, "Gemini_Autoplay_Assistant");
			if (this.playerStates.get(player) !== state) return;

			if (searchResult && searchResult.tracks.length > 0) {
				const topTrack = searchResult.tracks[0];
				if (player.autoPlay()) {
					player.setWillNext(topTrack);
					player.emit("AiAutoplay", `[AI Autoplay] Đã ghi đè Autoplay bằng Gemini: ${topTrack.title}`);
					//	willPlay: [track: Track, upcomingTracks: Track[]];

					player.emit("willPlay", topTrack, player.relatedTracks);
				}
			}
		} catch (error) {
			player.emit("AiAutoplay", `[AI Autoplay] Lỗi khi gọi Gemini:`, error);
		} finally {
			state.isAnalyzing = false;
		}
	}

	public onRegister(context: ExtensionContext): void {
		this.debugLog("info", `[AI Autoplay] Gemini Extension đã sẵn sàng (Model: gemini-2.5-flash)`);
	}

	public async provideSearch(context: ExtensionContext, payload: any): Promise<SearchResult | null> {
		if (payload.query.startsWith("ai:") && this.genAI) {
			const realQuery = payload.query.slice(3);
			// Logic tìm kiếm thông minh hơn bằng cách dùng Gemini để tinh chỉnh query
			if (!context.manager) return null;
			return context.manager.search(realQuery, payload.requestedBy);
		}
		return null;
	}
}
