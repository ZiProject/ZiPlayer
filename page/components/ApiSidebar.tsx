"use client";

import { useState, useEffect, useMemo } from "react";
import { ChevronDown, Search, Code, Play, Settings, Headphones, Layers } from "lucide-react";
import { generatedApiContent } from "./GeneratedApiContent";

interface ApiSidebarProps {
	activeSection?: string;
	onSectionChange?: (section: string) => void;
}

const groupMeta = [
	{ key: "core:class", title: "Core Classes", icon: Code },
	{ key: "core:interface", title: "Core Interfaces", icon: Settings },
	{ key: "core:type", title: "Core Types", icon: Layers },
	{ key: "core:function", title: "Core Functions", icon: Code },
	{ key: "extensions", title: "Extensions", icon: Headphones },
	{ key: "plugins", title: "Plugins", icon: Play },
];

function buildSections() {
	const entries = Object.entries(generatedApiContent as Record<string, { title?: string; badges?: readonly string[] }>);
	const sections = groupMeta.map((group) => ({ ...group, items: [] as string[] }));

	for (const [key, entry] of entries) {
		const badges = entry.badges || [];
		const scope = badges.includes("extensions") ? "extensions" : badges.includes("plugins") ? "plugins" : "core";
		const kind = badges.includes("class") ? "class" : badges.includes("interface") ? "interface" : badges.includes("type") ? "type" : badges.includes("function") ? "function" : "";
		const groupKey = kind ? `${scope}:${kind}` : scope;
		const section = sections.find((candidate) => candidate.key === groupKey);
		if (section) section.items.push(key);
	}

	return sections.filter((section) => section.items.length > 0);
}

export function ApiSidebar({ activeSection, onSectionChange }: ApiSidebarProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const sections = useMemo(buildSections, []);
	const [expandedSections, setExpandedSections] = useState<string[]>(() => sections.map((section) => section.title));

	useEffect(() => {
		if (!activeSection) return;
		const containing = sections.find((section) => section.items.includes(activeSection));
		if (containing && !expandedSections.includes(containing.title)) {
			setExpandedSections((prev) => [...prev, containing.title]);
		}
	}, [activeSection, sections, expandedSections]);

	const filteredSections = sections
		.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				const entry = generatedApiContent[item as keyof typeof generatedApiContent];
				const name = entry?.title || item;
				return `${item} ${name}`.toLowerCase().includes(searchQuery.toLowerCase());
			}),
		}))
		.filter((section) => section.items.length > 0);

	return (
		<div className='h-full flex flex-col bg-gradient-to-b from-gray-800/30 to-gray-900/30 backdrop-blur-sm'>
			<div className='p-6 border-b border-gray-700/50 bg-gray-800/20 backdrop-blur-sm'>
				<h1 className='text-2xl font-bold text-white mb-2'>ziplayer</h1>
				<div className='relative'>
					<Search className='absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4' />
					<input
						type='text'
						placeholder='Q Search...'
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
						className='w-full bg-gray-700/50 backdrop-blur-sm text-white pl-10 pr-4 py-2 rounded border border-gray-600/50 focus:outline-none focus:border-blue-500/50'
					/>
				</div>
			</div>

			<div className='flex-1 overflow-y-auto'>
				{filteredSections.map((section) => (
					<div key={section.title} className='border-b border-gray-700/30'>
						<button
							onClick={() => setExpandedSections((prev) => prev.includes(section.title) ? prev.filter((name) => name !== section.title) : [...prev, section.title])}
							className='w-full flex items-center justify-between px-6 py-3 text-left hover:bg-gray-700/30 transition-all duration-200'>
							<div className='flex items-center gap-3'>
								<section.icon className='w-4 h-4 text-green-400' />
								<span className='text-white font-medium'>{section.title}</span>
							</div>
							<ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${expandedSections.includes(section.title) ? "rotate-180" : ""}`} />
						</button>

						{expandedSections.includes(section.title) && (
							<div className='bg-gray-800/20'>
								{section.items.map((item) => {
									const apiItem = generatedApiContent[item as keyof typeof generatedApiContent];
									const displayName = apiItem?.title || item;
									const isActive = activeSection === item;
									return (
										<button
											key={item}
											onClick={() => onSectionChange?.(item)}
											className={`block w-full text-left px-8 py-2 text-sm transition-all duration-200 ${isActive ? "text-white bg-blue-600/30 border-r-2 border-blue-500" : "text-gray-300 hover:text-white hover:bg-gray-700/30"}`}>
											{displayName}
										</button>
									);
								})}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
