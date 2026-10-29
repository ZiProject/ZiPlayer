import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { ExternalLink, GitBranch, RefreshCw } from "lucide-react";

export default function ArchitecturePage() {
	return (
		<Layout>
			<div className='min-h-screen bg-gradient-to-br from-dark-900 via-dark-800 to-dark-900'>
				<div className='mx-auto max-w-7xl px-4 py-8'>
					<div className='grid gap-8 lg:grid-cols-4'>
						<aside className='lg:col-span-1'><Sidebar /></aside>
						<main className='min-w-0 space-y-6 lg:col-span-3'>
							<header className='space-y-4'>
								<div className='flex flex-wrap items-center justify-between gap-4'>
									<div>
										<p className='mb-2 text-sm font-medium uppercase tracking-[0.2em] text-brand-300'>System design</p>
										<h1 className='text-3xl font-bold text-white md:text-5xl'>ZiPlayer Architecture</h1>
									</div>
									<a href='/architecture/ziplayer-architecture.html?embed=1' target='_blank' rel='noreferrer' className='inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/80 transition hover:border-brand-400/40 hover:text-brand-200'>
										Mở toàn màn hình <ExternalLink className='h-4 w-4' />
									</a>
								</div>
								<p className='max-w-3xl text-lg leading-relaxed text-white/65'>Sơ đồ luồng ingestion, storage, TrackLoader và filter control plane của ZiPlayer. Bản xem bên dưới giữ nguyên tương tác zoom, pan và theme của sơ đồ gốc.</p>
							</header>

							<section className='overflow-hidden rounded-2xl border border-white/10 bg-black/20 shadow-2xl shadow-brand-950/20' aria-label='ZiPlayer architecture diagram'>
								<iframe title='ZiPlayer architecture diagram' src='/architecture/ziplayer-architecture.html?embed=1' className='h-[min(76vh,900px)] w-full border-0 bg-[#0b1020]' />
							</section>

							<section className='grid gap-4 md:grid-cols-2'>
								<div className='rounded-2xl border border-brand-400/20 bg-brand-500/5 p-5'>
									<div className='mb-3 flex items-center gap-3'><GitBranch className='h-5 w-5 text-brand-300' /><h2 className='font-semibold text-white'>Source of truth</h2></div>
									<p className='text-sm leading-6 text-white/65'>Sơ đồ được lưu trong <code className='text-brand-200'>page/public/architecture/ziplayer-architecture.html</code> và được phục vụ trực tiếp từ codebase, không phụ thuộc blob bên ngoài.</p>
								</div>
								<div className='rounded-2xl border border-white/10 bg-white/[0.03] p-5'>
									<div className='mb-3 flex items-center gap-3'><RefreshCw className='h-5 w-5 text-cyan-300' /><h2 className='font-semibold text-white'>Cập nhật theo code</h2></div>
									<p className='text-sm leading-6 text-white/65'>Chạy <code className='text-cyan-200'>pnpm architecture:sync</code> sau khi thay đổi core/controller/structures để đồng bộ lại artifact sơ đồ trong quy trình build hoặc CI.</p>
								</div>
							</section>
						</main>
					</div>
				</div>
			</div>
		</Layout>
	);
}
