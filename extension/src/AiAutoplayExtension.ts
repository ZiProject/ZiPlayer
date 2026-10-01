import { BaseExtension } from "ziplayer";
import type { ExtensionContext, ExtensionAfterPlayPayload, Track, SearchResult } from "ziplayer";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

/**
 * AiAutoplayExtension - Một Extension sử dụng Gemini 2.5 Flash để phân tích gu âm nhạc
 * và chuẩn bị các gợi ý bài hát tiếp theo một cách thông minh.
 */
export class AiAutoplayExtension extends BaseExtension {
	public name = "AiAutoplayExtension";
	public version = "1.1.0";
	public priority = 100;
	public player: any = null;

	private history: Track[] = [];
	private isAnalyzing = false;
	private genAI: GoogleGenerativeAI | null = null;
	/** Player đã được gắn listener trackStart (tránh đăng ký lặp lại ở mỗi lần afterPlay). */
	private listeningPlayer: unknown = null;

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
	public active(): boolean {
		if (!this.genAI) {
			console.warn("[AiAutoplayExtension] Gemini API Key không tìm thấy. AI sẽ không hoạt động.");
		}

		return true;
	}

	public async afterPlay(context: ExtensionContext, payload: ExtensionAfterPlayPayload): Promise<void> {
		if (!context.player) return;
		this.player = context.player;
		if (this.listeningPlayer === context.player) return;
		this.listeningPlayer = context.player;
		context.player.on("trackStart", (track: Track) => {
			if (this.history.length === 0 || this.history[this.history.length - 1].url !== track.url) {
				this.history.push(track);
				if (this.history.length > 10) this.history.shift();
			}
			if (this.genAI && this.history.length >= 2 && !this.isAnalyzing) {
				void this.analyzeMusicTaste(context);
			}
		});
	}

	private async analyzeMusicTaste(context: ExtensionContext): Promise<void> {
		const player = context.player;
		const manager = context.manager;
		if (!this.genAI || !player || !manager || !player.autoPlay()) return;
		this.isAnalyzing = true;

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

			const historyText = this.history.map((t, i) => `${i + 1}. ${t.title} - ${t.author}`).join("\n");

			const prompt = `
                Bạn là một chuyên gia âm nhạc AI. Dựa trên lịch sử nghe nhạc gần đây của người dùng dưới đây:
                ${historyText}

                Hãy phân tích gu âm nhạc hiện tại (thể loại, tâm trạng, nhịp điệu).
                Sau đó, hãy gợi ý MỘT bài hát duy nhất phù hợp nhất để phát tiếp theo.
                ⚠️ LƯU Ý: Tuyệt đối KHÔNG ĐƯỢC gợi ý lại bất kỳ bài hát nào đã xuất hiện trong danh sách lịch sử trên.
            `;

			const result = await model.generateContent(prompt);
			const response = await result.response;
			const text = response.text();

			const jsonMatch = text.match(/\{.*\}/s);
			if (!jsonMatch) throw new Error("AI không trả về JSON hợp lệ");

			const aiData = JSON.parse(jsonMatch[0]);
			if (typeof aiData?.suggestion !== "string" || !aiData.suggestion.trim()) {
				throw new Error("AI không trả về gợi ý bài hát hợp lệ");
			}
			this.forwardToPlayer("AiAutoplay", `[AI Autoplay] Gemini phân tích: ${aiData.analysis}`);
			this.forwardToPlayer("AiAutoplay", `[AI Autoplay] Gợi ý bài tiếp theo: ${aiData.suggestion} (${aiData.reason})`);

			const searchResult = await manager.search(aiData.suggestion, "Gemini_Autoplay_Assistant");

			if (searchResult && searchResult.tracks.length > 0) {
				const topTrack = searchResult.tracks[0];
				if (player.autoPlay()) {
					player.setWillNext(topTrack);
					this.forwardToPlayer("AiAutoplay", `[AI Autoplay] Đã ghi đè Autoplay bằng Gemini: ${topTrack.title}`);
					//	willPlay: [track: Track, upcomingTracks: Track[]];

					this.forwardToPlayer("willPlay", topTrack, player.relatedTracks);
				}
			}
		} catch (error) {
			this.forwardToPlayer("AiAutoplay", `[AI Autoplay] Lỗi khi gọi Gemini:`, error);
		} finally {
			this.isAnalyzing = false;
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
