"use client";

import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { CodeBlock } from "@/components/CodeBlock";
import { motion } from "framer-motion";
import { Play, Settings, Zap, CheckCircle, ArrowRight, Info } from "lucide-react";

const playerManagerCode = `import { PlayerManager } from "ziplayer";
import { SoundCloudPlugin, YouTubePlugin, SpotifyPlugin } from "@ziplayer/plugin";

const manager = new PlayerManager({
  plugins: [
    new SoundCloudPlugin(), 
    new YouTubePlugin(), 
    new SpotifyPlugin()
  ],
  // Cấu hình manager
  extractorTimeout: 50000,
  autoCleanup: true,
  cleanupInterval: 60000,
  enableSearchCache: true,
});`;

const createPlayerCode = `const player = await manager.create(guildId, {
  // Cấu hình player
  leaveOnEnd: true,
  leaveTimeout: 30000,
  userdata: { 
    channel: textChannel,
    guild: guild 
  },
  extensions: ["voiceExt"],
  volume: 80,
  leaveOnEmpty: true,
  leaveTimeout: 100000
});`;

const playerMethodsCode = `// Kết nối voice channel
await player.connect(voiceChannel);

// Phát nhạc
await player.play("Never Gonna Give You Up", userId);
await player.play("https://www.youtube.com/watch?v=dQw4w9WgXcQ", userId);

// Điều khiển phát nhạc
player.pause();
player.resume();
player.stop();
player.skip();
player.loop("off"); //"off" | "track" | "queue"

// Điều khiển volume
player.setVolume(75);

// Thoát khỏi voice channel
player.destroy(); // Ngắt kết nối hoàn toàn, không tự kết nối lại`;

const destroyPlayerCode = `// Destroy player - ngắt kết nối hoàn toàn
player.destroy();

// Khi destroy player:
// 1. Dừng audio player
// 2. Ngắt kết nối voice channel
// 3. Xóa queue và plugins
// 4. Gọi onDestroy() cho tất cả extensions
// 5. Lavalink extension sẽ:
//    - Ngắt kết nối hoàn toàn với Lavalink server
//    - Không tự động kết nối lại
//    - Cleanup tất cả resources
// 6. Emit "playerDestroy" event
// 7. Xóa tất cả event listeners

// Lưu ý: Sau khi destroy, player không thể sử dụng lại
// Cần tạo player mới nếu muốn phát nhạc lại`;

const eventsCode = `// Lắng nghe events
player.on("trackStart", (track) => {
  console.log("Bắt đầu phát:", track.title);
});

player.on("trackEnd", (track) => {
  console.log("Kết thúc:", track.title);
});

player.on("queueEnd", () => {
  console.log("Hết queue, tự động thoát...");
});

player.on("playerError", (error, track) => {
  console.error("Lỗi player:", error);
});

/* Player Events
	debug: [message: string, ...args: any[]];
	willPlay: [track: Track, upcomingTracks: Track[]];
	trackStart: [track: Track];
	trackEnd: [track: Track];
	queueEnd: [];
	playerError: [error: Error, track?: Track];
	connectionError: [error: Error];
	volumeChange: [oldVolume: number, newVolume: number];
	queueAdd: [track: Track];
	queueAddList: [tracks: Track[]];
	queueRemove: [track: Track, index: number];
	playerPause: [track: Track];
	playerResume: [track: Track];
	playerStop: [];
	playerDestroy: [];
	ttsStart: [payload: { text?: string; track?: Track }];
	ttsEnd: [];
*/
`;

const features = [
	{
		icon: Play,
		title: "Multi-source Support",
		description: "Hỗ trợ nhiều nguồn âm thanh thông qua hệ thống plugin",
		details: ["YouTube", "SoundCloud", "Spotify", "Direct URLs", "Playlists"],
	},
	{
		icon: Settings,
		title: "Rich Configuration",
		description: "Cấu hình linh hoạt cho từng player và manager",
		details: ["Volume control", "Auto-leave", "Queue limits", "User data"],
	},
	{
		icon: Zap,
		title: "Event-driven",
		description: "Hệ thống events mạnh mẽ để tương tác với player",
		details: ["Track events", "Queue events", "Error handling", "State changes"],
	},
];

export default function PlayerDocs() {
	return (
		<Layout>
			<div className='min-h-screen bg-gradient-to-br from-dark-900 via-dark-800 to-dark-900'>
				<div className='max-w-7xl mx-auto px-4 py-8'>
					<div className='grid lg:grid-cols-4 gap-8'>
						{/* Sidebar */}
						<aside className='lg:col-span-1'>
							<Sidebar />
						</aside>

						{/* Main content */}
						<main className='lg:col-span-3 space-y-12'>
							{/* Header */}
							<motion.div
								initial={{ opacity: 0, y: 30 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.6 }}
								className='text-center lg:text-left'>
								<h1 className='text-4xl lg:text-5xl font-bold mb-6'>
									<span className='text-white'>Player & </span>
									<span className='gradient-text'>Manager</span>
								</h1>
								<p className='text-xl text-white/70 leading-relaxed max-w-3xl'>
									Tìm hiểu cách sử dụng PlayerManager để quản lý players và Player để điều khiển phát nhạc trong Discord bot của
									bạn.
								</p>
							</motion.div>

							{/* Features Overview */}
							<motion.section
								initial={{ opacity: 0, y: 30 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.6, delay: 0.2 }}
								className='grid md:grid-cols-3 gap-6'>
								{features.map((feature, index) => (
									<motion.div
										key={feature.title}
										initial={{ opacity: 0, y: 30 }}
										animate={{ opacity: 1, y: 0 }}
										transition={{ duration: 0.5, delay: 0.3 + index * 0.1 }}
										className='card-hover'>
										<div className='flex flex-col items-center text-center space-y-4'>
											<div className='p-4 rounded-2xl bg-gradient-to-br from-brand-500/20 to-brand-600/20'>
												<feature.icon className='w-8 h-8 text-brand-400' />
											</div>

											<div className='space-y-2'>
												<h3 className='text-xl font-bold text-white'>{feature.title}</h3>
												<p className='text-white/70 leading-relaxed'>{feature.description}</p>
												<ul className='text-sm text-white/60 space-y-1'>
													{feature.details.map((detail, idx) => (
														<li
															key={idx}
															className='flex items-center gap-2'>
															<CheckCircle className='w-3 h-3 text-green-400 flex-shrink-0' />
															{detail}
														</li>
													))}
												</ul>
											</div>
										</div>
									</motion.div>
								))}
							</motion.section>

							{/* PlayerManager */}
							<motion.section
								initial={{ opacity: 0, y: 30 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.6, delay: 0.4 }}
								className='glass-strong rounded-2xl p-8'>
								<div className='flex items-center gap-3 mb-6'>
									<div className='p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-cyan-500/20'>
										<Settings className='w-6 h-6 text-blue-400' />
									</div>
									<h2 className='text-2xl font-bold text-white'>PlayerManager</h2>
								</div>

								<p className='text-white/70 mb-6 text-lg'>
									PlayerManager là trung tâm quản lý tất cả players trong bot của bạn. Nó cho phép bạn tạo, cấu hình và quản lý
									nhiều players cho các guild khác nhau.
								</p>

								<CodeBlock
									code={playerManagerCode}
									language='typescript'
									className='mb-6'
								/>

								<div className='grid md:grid-cols-2 gap-6'>
									<div className='space-y-4'>
										<h3 className='text-lg font-semibold text-white'>Tính năng chính</h3>
										<ul className='space-y-2 text-white/70'>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Quản lý nhiều players cho các guild khác nhau</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Tự động cleanup players không hoạt động</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Hỗ trợ plugin system mạnh mẽ</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Cấu hình mặc định cho tất cả players</span>
											</li>
										</ul>
									</div>

									<div className='space-y-4'>
										<h3 className='text-lg font-semibold text-white'>API Methods</h3>
										<div className='space-y-2 text-sm'>
											<div className='bg-dark-800/50 rounded-lg p-3'>
												<code className='text-brand-300'>create(guildId, options)</code>
												<p className='text-white/60 mt-1'>Tạo player mới cho guild</p>
											</div>
											<div className='bg-dark-800/50 rounded-lg p-3'>
												<code className='text-brand-300'>get(guildId)</code>
												<p className='text-white/60 mt-1'>Lấy player theo guild ID</p>
											</div>
											<div className='bg-dark-800/50 rounded-lg p-3'>
												<code className='text-brand-300'>destroy(guildId)</code>
												<p className='text-white/60 mt-1'>Xóa player khỏi manager</p>
											</div>
										</div>
									</div>
								</div>
							</motion.section>

							{/* Player */}
							<motion.section
								initial={{ opacity: 0, y: 30 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.6, delay: 0.6 }}
								className='glass-strong rounded-2xl p-8'>
								<div className='flex items-center gap-3 mb-6'>
									<div className='p-2 rounded-lg bg-gradient-to-br from-purple-500/20 to-pink-500/20'>
										<Play className='w-6 h-6 text-purple-400' />
									</div>
									<h2 className='text-2xl font-bold text-white'>Player</h2>
								</div>

								<p className='text-white/70 mb-6 text-lg'>
									Player là đối tượng chính để điều khiển phát nhạc trong một guild. Mỗi guild có thể có một player riêng biệt.
								</p>

								<h3 className='text-xl font-semibold text-white mb-4'>Tạo Player</h3>
								<CodeBlock
									code={createPlayerCode}
									language='typescript'
									className='mb-8'
								/>

								<h3 className='text-xl font-semibold text-white mb-4'>Sử dụng Player</h3>
								<CodeBlock
									code={playerMethodsCode}
									language='typescript'
									className='mb-8'
								/>

								<h3 className='text-xl font-semibold text-white mb-4'>Destroy Player</h3>
								<CodeBlock
									code={destroyPlayerCode}
									language='typescript'
									className='mb-8'
								/>

								<h3 className='text-xl font-semibold text-white mb-4'>Events</h3>
								<CodeBlock
									code={eventsCode}
									language='typescript'
								/>
							</motion.section>

							{/* Best Practices */}
							<motion.section
								initial={{ opacity: 0, y: 30 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.6, delay: 0.8 }}
								className='glass-subtle rounded-2xl p-8'>
								<div className='flex items-center gap-3 mb-6'>
									<div className='p-2 rounded-lg bg-gradient-to-br from-green-500/20 to-emerald-500/20'>
										<Info className='w-6 h-6 text-green-400' />
									</div>
									<h2 className='text-2xl font-bold text-white'>Best Practices</h2>
								</div>

								<div className='grid md:grid-cols-2 gap-6'>
									<div className='space-y-4'>
										<h3 className='text-lg font-semibold text-white'>Memory Management</h3>
										<ul className='space-y-2 text-white/70'>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Sử dụng leaveOnEnd để tự động thoát khi hết nhạc</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Đặt leaveTimeout hợp lý (30-60 giây)</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Xóa players không sử dụng bằng destroy()</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Destroy() ngắt kết nối hoàn toàn, không tự kết nối lại</span>
											</li>
										</ul>
									</div>

									<div className='space-y-4'>
										<h3 className='text-lg font-semibold text-white'>Error Handling</h3>
										<ul className='space-y-2 text-white/70'>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Luôn xử lý lỗi khi connect và play</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Sử dụng try-catch cho các async operations</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Lắng nghe error events để debug</span>
											</li>
											<li className='flex items-start gap-2'>
												<CheckCircle className='w-5 h-5 text-green-400 flex-shrink-0 mt-0.5' />
												<span>Lavalink extension tự động cleanup khi destroy</span>
											</li>
										</ul>
									</div>
								</div>
							</motion.section>

							{/* Next Steps */}
							<motion.section
								initial={{ opacity: 0, y: 30 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.6, delay: 1.0 }}
								className='glass-strong rounded-2xl p-8 text-center'>
								<h2 className='text-2xl font-bold text-white mb-4'>Tiếp theo: Queue & Controls</h2>
								<p className='text-white/70 mb-6'>Tìm hiểu cách sử dụng queue system và các điều khiển phát nhạc nâng cao.</p>
								<a
									href='/docs/queue'
									className='btn-primary inline-flex items-center gap-2'>
									Xem Queue & Controls
									<ArrowRight className='w-4 h-4' />
								</a>
							</motion.section>
						</main>
					</div>
				</div>
			</div>
		</Layout>
	);
}
