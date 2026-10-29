import { NavLink } from "./NavLink";

const sections = [
	{
		title: "Getting Started",
		links: [
			{ href: "/docs", label: "Overview" },
			{ href: "/docs/getting-started", label: "Quick Start" },
		],
	},
	{
		title: "Core",
		links: [
			{ href: "/docs/player", label: "Player & Manager" },
			{ href: "/docs/queue", label: "Queue & Controls" },
			{ href: "/docs/events", label: "Events" },
		],
	},
	{
		title: "Ecosystem",
		links: [
			{ href: "/docs/plugins", label: "Plugins" },
			{ href: "/docs/extensions", label: "Extensions" },
			{ href: "/docs/examples", label: "Examples" },
		],
	},
	{
		title: "Reference",
		links: [
			{ href: "/architecture", label: "Architecture" },
			{ href: "/api-reference", label: "API Reference" },
		],
	},
];

export function Sidebar() {
	return (
		<div className='glass rounded-lg p-4 sticky top-20'>
			<div className='space-y-6'>
				{sections.map((s) => (
					<div key={s.title}>
						<div className='mb-2 px-3 text-xs uppercase tracking-wider text-white/50'>{s.title}</div>
						<div className='space-y-1'>
							{s.links.map((l) => (
								<NavLink
									key={l.href}
									href={l.href}>
									{l.label}
								</NavLink>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
