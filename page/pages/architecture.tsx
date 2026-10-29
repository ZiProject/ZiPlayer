import dynamic from "next/dynamic";
import { Sidebar } from "@/components/Sidebar";

const Layout = dynamic(() => import("@/components/Layout").then((module) => module.Layout), { ssr: false });
import { ArrowUpRight, GitBranch, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";

const stats = [
	["01", "Core pipeline", "Source to playback"],
	["02", "Control plane", "Queue, filters, recovery"],
	["03", "Output layer", "Voice and WebAudio"],
];

export default function ArchitecturePage() {
	return (
		<Layout>
			<div className="relative min-h-screen overflow-hidden bg-[#080b12]">
			<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_70%_0%,rgba(34,211,238,0.12),transparent_30%),radial-gradient(circle_at_20%_30%,rgba(99,102,241,0.1),transparent_28%)]" />
			<div className="relative mx-auto max-w-[1500px] px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
				<div className="grid gap-8 xl:grid-cols-[240px_minmax(0,1fr)]">
					<aside className="hidden xl:block"><Sidebar /></aside>
					<main className="min-w-0">
						<div className="mb-8 flex flex-col gap-6 border-b border-white/10 pb-8 lg:flex-row lg:items-end lg:justify-between">
							<div className="max-w-3xl">
								<div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300"><Sparkles className="h-4 w-4" /> Technical overview</div>
								<h1 className="text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl lg:text-6xl">How ZiPlayer moves sound.</h1>
								<p className="mt-5 max-w-2xl text-base leading-7 text-slate-400 sm:text-lg">A living map of the ingestion pipeline, orchestration layer, and output connections behind ZiPlayer.</p>
							</div>
							<a href="/architecture/ziplayer-architecture.html?embed=1" target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-300/25 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:border-cyan-200/60 hover:bg-cyan-300/20">Open full canvas <ArrowUpRight className="h-4 w-4" /></a>
						</div>

						<div className="mb-8 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-3">
							{stats.map(([number, title, detail]) => <div key={number} className="bg-white/[0.035] p-5"><div className="mb-8 font-mono text-xs text-cyan-300/70">{number}</div><div className="font-medium text-white">{title}</div><div className="mt-1 text-sm text-slate-500">{detail}</div></div>)}
						</div>

						<section className="overflow-hidden rounded-2xl border border-white/10 bg-[#0d111b] shadow-2xl shadow-cyan-950/20" aria-label="ZiPlayer architecture diagram">
							<div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-xs text-slate-500"><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Live architecture map</div><span className="font-mono">ziplayer / system-design</span></div>
							<iframe title="ZiPlayer architecture diagram" src="/architecture/ziplayer-architecture.html?embed=1" className="h-[min(74vh,860px)] w-full border-0 bg-[#0b1020]" />
						</section>

						<div className="mt-8 grid gap-4 md:grid-cols-2">
							<div className="rounded-2xl border border-white/10 bg-white/[0.035] p-6"><div className="mb-4 flex items-center gap-3"><ShieldCheck className="h-5 w-5 text-emerald-300" /><h2 className="font-semibold text-white">Source of truth</h2></div><p className="text-sm leading-6 text-slate-400">The diagram is versioned in <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-cyan-200">page/public/architecture</code> and served directly by the site.</p></div>
							<div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.04] p-6"><div className="mb-4 flex items-center gap-3"><RefreshCw className="h-5 w-5 text-cyan-300" /><h2 className="font-semibold text-white">Keep it in sync</h2></div><p className="text-sm leading-6 text-slate-400">Run <code className="rounded bg-cyan-300/10 px-1.5 py-0.5 font-mono text-xs text-cyan-200">pnpm architecture:sync</code> after core changes to refresh the generated artifact in CI.</p></div>
						</div>
					</main>
				</div>
			</div>
			</div>
		</Layout>
	);
}
