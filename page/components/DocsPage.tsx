import Link from "next/link";
import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { CodeBlock } from "@/components/CodeBlock";
import { ArrowRight, Check, Copy } from "lucide-react";

type Section = {
	title: string;
	description?: string;
	code?: string;
	bullets?: string[];
};

type DocsPageProps = {
	eyebrow?: string;
	title: string;
	accent: string;
	description: string;
	sections: Section[];
	next?: { label: string; href: string };
};

export function DocsPage({ eyebrow = "Documentation", title, accent, description, sections, next }: DocsPageProps) {
	return (
		<Layout>
			<div className='mx-auto grid max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:px-8'>
				<aside className='hidden lg:block'>
					<Sidebar />
				</aside>
				<main className='min-w-0'>
					<header className='mb-10 max-w-3xl'>
						<p className='mb-4 text-xs font-bold uppercase tracking-[0.22em] text-brand-300'>{eyebrow}</p>
						<h1 className='font-display text-4xl font-bold tracking-tight text-white sm:text-5xl'>
							{title} <span className='gradient-text'>{accent}</span>
						</h1>
						<p className='mt-5 text-lg leading-8 text-white/60'>{description}</p>
					</header>
					<div className='space-y-6'>
						{sections.map((section, index) => (
							<section
								key={section.title}
								className='card-hover p-6 sm:p-8'>
								<div className='mb-5 flex items-start gap-4'>
									<span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-300/10 font-mono text-xs text-brand-200'>
										{String(index + 1).padStart(2, "0")}
									</span>
									<div>
										<h2 className='font-display text-xl font-semibold text-white'>{section.title}</h2>
										{section.description && <p className='mt-2 leading-7 text-white/55'>{section.description}</p>}
									</div>
								</div>
								{section.bullets && (
									<ul className='mb-5 grid gap-3 text-sm text-white/65 sm:grid-cols-2'>
										{section.bullets.map((bullet) => (
											<li
												key={bullet}
												className='flex gap-2'>
												<Check
													size={16}
													className='mt-0.5 shrink-0 text-brand-300'
												/>
												{bullet}
											</li>
										))}
									</ul>
								)}
								{section.code && (
									<div className='relative'>
										<Copy
											size={15}
											className='pointer-events-none absolute right-4 top-4 z-10 text-white/35'
										/>
										<CodeBlock
											code={section.code}
											language='typescript'
										/>
									</div>
								)}
							</section>
						))}
					</div>
					{next && (
						<Link
							href={next.href}
							className='btn-primary mt-8 inline-flex items-center gap-2'>
							{next.label}
							<ArrowRight size={16} />
						</Link>
					)}
				</main>
			</div>
		</Layout>
	);
}
