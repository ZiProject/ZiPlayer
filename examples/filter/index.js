const { PlayerManager } = require("../../core/dist");
const { YouTubePlugin } = require("../../plugins/dist");
const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();
// Tạo Discord client
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

// Tạo PlayerManager với YouTube plugin
const manager = new PlayerManager({
	plugins: [new YouTubePlugin()],
});

// Đăng ký event listeners
manager.on("trackStart", (player, track) => {
	console.log(`🎵 Đang phát: ${track.title}`);
});

manager.on("filterApplied", (player, filter) => {
	console.log(`🎛️ Đã áp dụng filter: ${filter.name} - ${filter.description}`);
});

manager.on("filterRemoved", (player, filter) => {
	console.log(`🎛️ Đã gỡ filter: ${filter.name}`);
});

manager.on("filtersCleared", (player) => {
	console.log(`🎛️ Đã xóa tất cả filters`);
});
manager.on("debug", console.log);

// Bot ready event
client.once("ready", () => {
	console.log(`🤖 Bot đã sẵn sàng! Đăng nhập với tên: ${client.user.tag}`);
});

// Xử lý commands
client.on("messageCreate", async (message) => {
	if (message.author.bot) return;
	if (!message.content.startsWith("!")) return;

	const args = message.content.slice(1).trim().split(/ +/);
	const command = args.shift().toLowerCase();

	try {
		switch (command) {
			case "play":
				if (!message.member.voice.channel) {
					return message.reply("❌ Bạn cần tham gia kênh thoại trước!");
				}

				const query = args.join(" ");
				if (!query) {
					return message.reply("❌ Vui lòng cung cấp tên bài hát hoặc URL!");
				}

				const player = await manager.create(message.guildId, {
					// Áp dụng filters mặc định khi tạo player
					filters: ["bassboost"],
				});

				await player.connect(message.member.voice.channel);
				await player.play(query, message.author.id);

				message.reply(`🎵 Đang tìm kiếm và phát: **${query}**`);
				break;

			case "filter":
				const player2 = manager.get(message.guildId);
				if (!player2) {
					return message.reply("❌ Không có player nào đang hoạt động!");
				}

				const filterName = args[0];
				if (!filterName) {
					// Hiển thị danh sách filters có sẵn
					const availableFilters = player2.getAvailableFilters();
					const categories = {};

					availableFilters.forEach((filter) => {
						const category = filter.category || "other";
						if (!categories[category]) {
							categories[category] = [];
						}
						categories[category].push(filter);
					});

					let response = "🎛️ **Danh sách filters có sẵn:**\n\n";
					Object.keys(categories).forEach((category) => {
						response += `**${category.toUpperCase()}:**\n`;
						categories[category].forEach((filter) => {
							response += `• \`${filter.name}\` - ${filter.description}\n`;
						});
						response += "\n";
					});

					return message.reply(response);
				}

				const success = player2.applyFilter(filterName);
				if (success) {
					message.reply(`✅ Đã áp dụng filter: **${filterName}**`);
				} else {
					message.reply(`❌ Không thể áp dụng filter: **${filterName}**`);
				}
				break;

			case "removefilter":
				const player3 = manager.get(message.guildId);
				if (!player3) {
					return message.reply("❌ Không có player nào đang hoạt động!");
				}

				const filterToRemove = args[0];
				if (!filterToRemove) {
					const activeFilters = player3.getActiveFilters();
					if (activeFilters.length === 0) {
						return message.reply("❌ Không có filter nào đang được áp dụng!");
					}

					let response = "🎛️ **Filters đang được áp dụng:**\n";
					activeFilters.forEach((filter) => {
						response += `• \`${filter.name}\` - ${filter.description}\n`;
					});

					return message.reply(response);
				}

				const removed = player3.removeFilter(filterToRemove);
				if (removed) {
					message.reply(`✅ Đã gỡ filter: **${filterToRemove}**`);
				} else {
					message.reply(`❌ Không tìm thấy filter: **${filterToRemove}**`);
				}
				break;

			case "clearfilters":
				const player4 = manager.get(message.guildId);
				if (!player4) {
					return message.reply("❌ Không có player nào đang hoạt động!");
				}

				player4.clearFilters();
				message.reply("✅ Đã xóa tất cả filters!");
				break;

			case "filters":
				const player5 = manager.get(message.guildId);
				if (!player5) {
					return message.reply("❌ Không có player nào đang hoạt động!");
				}

				const activeFilters = player5.getActiveFilters();
				if (activeFilters.length === 0) {
					return message.reply("❌ Không có filter nào đang được áp dụng!");
				}

				let response = "🎛️ **Filters đang được áp dụng:**\n";
				activeFilters.forEach((filter) => {
					response += `• \`${filter.name}\` - ${filter.description}\n`;
				});

				const filterString = player5.getFilterString();
				if (filterString) {
					response += `\n**FFmpeg Filter String:**\n\`${filterString}\``;
				}

				message.reply(response);
				break;

			case "filtercategory":
				const player6 = manager.get(message.guildId);
				if (!player6) {
					return message.reply("❌ Không có player nào đang hoạt động!");
				}

				const category = args[0];
				if (!category) {
					const availableFilters = player6.getAvailableFilters();
					const categories = [...new Set(availableFilters.map((f) => f.category).filter(Boolean))];

					let response = "🎛️ **Danh sách categories:**\n";
					categories.forEach((cat) => {
						response += `• \`${cat}\`\n`;
					});

					return message.reply(response);
				}

				const categoryFilters = player6.getFiltersByCategory(category);
				if (categoryFilters.length === 0) {
					return message.reply(`❌ Không tìm thấy category: **${category}**`);
				}

				let categoryResponse = `🎛️ **Filters trong category "${category}":**\n`;
				categoryFilters.forEach((filter) => {
					categoryResponse += `• \`${filter.name}\` - ${filter.description}\n`;
				});

				message.reply(categoryResponse);
				break;

			case "help":
				const helpText = `
🎵 **Music Bot với Audio Filters**

**Commands cơ bản:**
• \`!play <query>\` - Phát nhạc (với bassboost và normalize mặc định)
• \`!pause\` - Tạm dừng
• \`!resume\` - Tiếp tục
• \`!skip\` - Bỏ qua bài
• \`!stop\` - Dừng và xóa queue

**Filter Commands:**
• \`!filter\` - Xem danh sách filters có sẵn
• \`!filter <name>\` - Áp dụng filter
• \`!removefilter\` - Xem filters đang áp dụng
• \`!removefilter <name>\` - Gỡ filter
• \`!clearfilters\` - Xóa tất cả filters
• \`!filters\` - Xem filters đang áp dụng
• \`!filtercategory\` - Xem danh sách categories
• \`!filtercategory <category>\` - Xem filters trong category

**Ví dụ:**
• \`!play Never Gonna Give You Up\`
• \`!filter nightcore\`
• \`!filter vaporwave\`
• \`!removefilter nightcore\`
• \`!clearfilters\`
                `;

				message.reply(helpText);
				break;

			default:
				message.reply("❌ Command không tồn tại! Sử dụng `!help` để xem danh sách commands.");
		}
	} catch (error) {
		console.error("Error:", error);
		message.reply(`❌ Có lỗi xảy ra: ${error.message}`);
	}
});

// Đăng nhập bot
client.login(process.env.DISCORD_TOKEN);
