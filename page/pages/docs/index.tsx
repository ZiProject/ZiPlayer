import Link from "next/link";
import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import {
	ArrowRight,
	AudioLines,
	BookOpen,
	Boxes,
	Check,
	Code2,
	GitBranch,
	Layers3,
	Package,
	Radio,
	ShieldCheck,
	Sparkles,
	Zap,
} from "lucide-react";

const highlights = [
	[
		AudioLines,
		"Shared audio pipeline",
		"One AudioPlayer fans out server-volume-adjusted Opus packets to Discord Voice and browser subscribers.",
	],
	[
		GitBranch,
		"Bus + controllers",
		"A decoupled, event-driven core keeps playback, queue, filters, and lifecycle state testable.",
	],
	[
		Sparkles,
		"Smart recovery",
		"Preloading, anti-stuck recovery, controlled skips, autoplay, crossfade, and loudness normalization work together.",
	],
	[
		Boxes,
		"Plugin-first sources",
		"Connect YouTube, SoundCloud, Spotify, TTS, attachments, or your own resolver through extensions.",
	],
];

const steps = [
	["01", "Install the runtime", "npm install ziplayer @discordjs/voice discord.js"],
	["02", "Create one manager", "const manager = new PlayerManager({ plugins, autoCleanup: true });"],
	["03", "Create a guild player", "const player = await manager.create(guildId);"],
	["04", "Connect and play", "await player.connect(voiceChannel);\nawait player.play(query, { requestedBy: userId });"],
];

const topics = [
	[BookOpen, "Getting started", "Install dependencies, configure plugins, and ship your first bot.", "/docs/getting-started"],
	[Code2, "Player API", "Playback controls, queue operations, events, state, and lifecycle.", "/docs/player"],
	[Radio, "Browser playback", "Publish the shared Opus stream through your application WebSocket gateway.", "/docs/examples"],
	[Layers3, "Architecture", "Understand the manager, Bus, controllers, facade, and audio subscribers.", "/architecture"],
];

export default function Docs() {
	return (
		<Layout>
			<div className='mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8'>
				<div className='grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)]'>
					<aside className='hidden lg:block'>
						<Sidebar />
					</aside>
					<main className='min-w-0'>
						<section className='relative overflow-hidden rounded-3xl border border-brand-300/20 bg-gradient-to-br from-brand-300/10 via-white/[0.03] to-accent-400/10 p-8 sm:p-12'>
							<div className='absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-300/10 blur-3xl' />
							<div className='relative max-w-3xl'>
								<div className='mb-5 inline-flex items-center gap-2 rounded-full border border-brand-300/25 bg-brand-300/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-brand-200'>
									<Sparkles size={14} /> Core documentation
								</div>
								<h1 className='font-display text-4xl font-bold tracking-tight text-white sm:text-6xl'>
									Build reliable audio flows with <span className='gradient-text'>ZiPlayer.</span>
								</h1>
								<p className='mt-6 max-w-2xl text-lg leading-8 text-white/65'>
									An enterprise-grade Discord audio engine built on{" "}
									<code className='rounded bg-white/10 px-1.5 py-0.5 text-brand-200'>@discordjs/voice</code>. Keep application
									code simple with a clean Player facade and a powerful controller architecture underneath.
								</p>
								<div className='mt-8 flex flex-wrap gap-3'>
									<Link
										href='/docs/getting-started'
										className='btn-primary'>
										Start building <ArrowRight size={16} />
									</Link>
									<Link
										href='/architecture'
										className='btn-secondary'>
										Explore architecture
									</Link>
								</div>
							</div>
						</section>

						<section className='mt-12 grid gap-4 sm:grid-cols-2'>
							{highlights.map(([Icon, title, description]) => (
								<article
									key={title as string}
									className='card-hover'>
									<Icon
										className='mb-5 text-brand-300'
										size={22}
									/>
									<h2 className='font-display text-lg font-semibold text-white'>{title as string}</h2>
									<p className='mt-2 text-sm leading-6 text-white/55'>{description as string}</p>
								</article>
							))}
						</section>

						<section className='mt-16 grid gap-8 lg:grid-cols-[1fr_1.15fr] lg:items-start'>
							<div>
								<p className='text-xs font-bold uppercase tracking-[0.2em] text-brand-300'>Quick start</p>
								<h2 className='mt-3 font-display text-3xl font-bold text-white'>From zero to playback.</h2>
								<p className='mt-4 leading-7 text-white/60'>
									Create a single process-wide manager, let plugins resolve sources, and use the facade for everyday playback.
								</p>
								<div className='mt-7 flex items-center gap-3 text-sm text-white/55'>
									<ShieldCheck
										size={18}
										className='text-success-400'
									/>{" "}
									Node.js 20.3+ · TypeScript strict
								</div>
							</div>
							<div className='space-y-3'>
								{steps.map(([number, title, code]) => (
									<div
										key={number}
										className='flex gap-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4'>
										<span className='font-mono text-sm text-brand-300'>{number}</span>
										<div className='min-w-0 flex-1'>
											<h3 className='font-semibold text-white'>{title}</h3>
											<pre className='code-block mt-3 whitespace-pre-wrap text-xs text-brand-100'>{code}</pre>
										</div>
									</div>
								))}
							</div>
						</section>

						<section className='mt-16'>
							<div className='flex items-end justify-between gap-4'>
								<div>
									<p className='text-xs font-bold uppercase tracking-[0.2em] text-brand-300'>Navigate the core</p>
									<h2 className='mt-3 font-display text-3xl font-bold text-white'>Learn by system.</h2>
								</div>
								<Zap className='hidden text-brand-300 sm:block' />
							</div>
							<div className='mt-6 grid gap-4 sm:grid-cols-2'>
								{topics.map(([Icon, title, description, href]) => (
									<Link
										href={href as string}
										key={title as string}
										className='card-hover group'>
										<Icon
											size={22}
											className='text-brand-300'
										/>
										<h3 className='mt-5 font-display text-xl font-semibold text-white'>{title as string}</h3>
										<p className='mt-2 text-sm leading-6 text-white/55'>{description as string}</p>
										<span className='mt-5 inline-flex items-center gap-2 text-sm font-semibold text-brand-300'>
											Read guide{" "}
											<ArrowRight
												size={15}
												className='transition group-hover:translate-x-1'
											/>
										</span>
									</Link>
								))}
							</div>
						</section>

						<section className='mt-16 rounded-3xl border border-white/10 bg-white/[0.03] p-7 sm:p-9'>
							<div className='flex items-start gap-4'>
								<Package className='mt-1 text-brand-300' />
								<div>
									<h2 className='font-display text-2xl font-bold text-white'>The public API is the contract.</h2>
									<p className='mt-3 max-w-2xl leading-7 text-white/60'>
										Use <code className='rounded bg-white/10 px-1.5 py-0.5 text-brand-200'>PlayerManager</code>,{" "}
										<code className='rounded bg-white/10 px-1.5 py-0.5 text-brand-200'>Player</code>, plugins, and documented
										options in normal applications. Reach for Bus and controller internals only when extending the core itself.
									</p>
									<ul className='mt-5 grid gap-3 text-sm text-white/70 sm:grid-cols-2'>
										<li className='flex gap-2'>
											<Check
												size={16}
												className='mt-0.5 text-success-400'
											/>{" "}
											Await async playback operations
										</li>
										<li className='flex gap-2'>
											<Check
												size={16}
												className='mt-0.5 text-success-400'
											/>{" "}
											Keep one manager per process
										</li>
										<li className='flex gap-2'>
											<Check
												size={16}
												className='mt-0.5 text-success-400'
											/>{" "}
											Add sources through plugins
										</li>
										<li className='flex gap-2'>
											<Check
												size={16}
												className='mt-0.5 text-success-400'
											/>{" "}
											Treat generated dist as read-only
										</li>
									</ul>
								</div>
							</div>
						</section>
					</main>
				</div>
			</div>
		</Layout>
	);
}
