"use client";

import { useState, useEffect } from "react";
import { Copy, Check, ExternalLink, Play, Music, Mic, Headphones, Settings } from "lucide-react";

import { generatedApiContent } from "./GeneratedApiContent";

interface ApiParam {
	name: string;
	type: string;
	description: string;
	optional: boolean;
	default: string;
	variation: string;
}

interface ApiMethod {
	name: string;
	signature: string;
	description: string;
	example: string;
	code: string;
	parameters: ApiParam[];
	returns: { type: string; description: string } | null;
}

interface ApiEvent {
	name: string;
	description: string;
	parameters: string[];
}

interface ApiProperty {
	name: string;
	type: string;
	description: string;
	optional: boolean;
	default: string;
}

interface ApiEntry {
	title: string;
	description: string;
	summary: string;
	badges: string[];
	publicFrom: string[];
	code: string;
	methods: ApiMethod[];
	events: ApiEvent[];
	properties: ApiProperty[];
	params: ApiParam[];
	returns: { type: string; description: string } | null;
}

// Cast qua `unknown` trước để bỏ hẳn các literal/readonly types do `as const`
// trong file auto-generated sinh ra (vd: readonly tuple cho `badges`, union
// literal cho `code`/`description`...). Nếu cast thẳng sang Record<string,
// ApiEntry>, TS sẽ báo lỗi "may be a mistake" vì readonly không khớp mutable.
const apiContent = generatedApiContent as unknown as Record<string, ApiEntry>;

interface ApiContentProps {
	activeSection?: string;
	onSectionChange?: (section: string) => void;
}

export function ApiContent({ activeSection: propActiveSection, onSectionChange }: ApiContentProps) {
	const [copiedCode, setCopiedCode] = useState<string | null>(null);
	const [internalActiveSection, setInternalActiveSection] = useState("playermanager");

	// Use prop or internal state
	const activeSection = propActiveSection || internalActiveSection;

	// Listen for sidebar item clicks (fallback for when not using props)
	useEffect(() => {
		const handleSidebarItemClick = (event: CustomEvent) => {
			const item = event.detail;
			if (item && apiContent[item as keyof typeof apiContent]) {
				if (onSectionChange) {
					onSectionChange(item);
				} else {
					setInternalActiveSection(item);
				}
			}
		};

		window.addEventListener("sidebarItemClick", handleSidebarItemClick as EventListener);

		return () => {
			window.removeEventListener("sidebarItemClick", handleSidebarItemClick as EventListener);
		};
	}, [onSectionChange]);

	const copyCode = (code: string) => {
		navigator.clipboard.writeText(code);
		setCopiedCode(code);
		setTimeout(() => setCopiedCode(null), 2000);
	};

	const handleSectionChange = (item: string) => {
		if (onSectionChange) {
			onSectionChange(item);
		} else {
			setInternalActiveSection(item);
		}
	};

	const currentContent = apiContent[activeSection as keyof typeof apiContent] || {
		title: "Not Found",
		description: "The requested API documentation was not found.",
		badges: [],
		code: "",
		methods: [],
		events: [],
	};

	return (
		<div className='max-w-4xl mx-auto p-8 bg-gradient-to-br from-gray-900/40 to-gray-800/40 backdrop-blur-sm min-h-full'>
			{/* Header */}
			<div className='mb-8'>
				<div className='flex items-center gap-4 mb-4'>
					<div className='w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg'>
						<Play className='w-6 h-6 text-white' />
					</div>
					<div>
						<h1 className='text-4xl font-bold text-white'>{currentContent.title || "API Documentation"}</h1>
						<div className='flex gap-2 mt-2'>
							{currentContent.badges &&
								currentContent.badges.map((badge) => (
									<span
										key={badge}
										className='px-2 py-1 text-xs font-medium bg-gray-700/50 backdrop-blur-sm text-gray-300 rounded border border-gray-600/30'>
										{badge}
									</span>
								))}
						</div>
					</div>
				</div>
				{currentContent.description && <p className='text-xl text-gray-300 leading-relaxed'>{currentContent.description}</p>}
			</div>

			{/* Code Example */}
			{currentContent.code && currentContent.code.trim() && currentContent.code !== "/" && (
				<div className='mb-8'>
					<div className='flex items-center justify-between mb-4'>
						<h2 className='text-2xl font-bold text-white'>Example</h2>
						<button
							onClick={() => copyCode(currentContent.code)}
							className='flex items-center gap-2 px-3 py-1 bg-gray-700/50 backdrop-blur-sm hover:bg-gray-600/50 text-white rounded transition-colors border border-gray-600/30'>
							{copiedCode === currentContent.code ?
								<Check className='w-4 h-4' />
							:	<Copy className='w-4 h-4' />}
							{copiedCode === currentContent.code ? "Copied!" : "Copy"}
						</button>
					</div>
					<div className='relative'>
						<div className='absolute inset-0 bg-gradient-to-r from-blue-500/20 to-purple-500/20 rounded-lg blur-xl' />
						<div className='relative bg-gray-800/50 backdrop-blur-sm rounded-lg p-6 border border-gray-700/50 shadow-lg'>
							<pre className='text-sm text-gray-300 overflow-x-auto'>
								<code>{currentContent.code}</code>
							</pre>
						</div>
					</div>
				</div>
			)}

			{/* Methods */}
			{currentContent.methods && currentContent.methods.length > 0 && (
				<div className='mb-8'>
					<h2 className='text-2xl font-bold text-white mb-6'>Methods</h2>
					<div className='space-y-6'>
						{currentContent.methods.map((method, index) => (
							<div
								key={index}
								className='bg-gray-800/50 backdrop-blur-sm rounded-lg p-6 border border-gray-700/50 shadow-lg'>
								<div className='flex items-start justify-between mb-3'>
									<div className='flex-1'>
										<h3 className='text-xl font-bold text-white mb-2'>{method.name || "Unnamed Method"}</h3>
										{method.description && method.description.trim() && method.description !== "/" && (
											<p className='text-gray-300 mb-3'>{method.description}</p>
										)}
										{method.signature && method.signature.trim() && method.signature !== "/" && (
											<code className='text-sm text-blue-400 bg-gray-900/50 backdrop-blur-sm px-2 py-1 rounded border border-gray-700/50 block mb-3'>
												{method.signature}
											</code>
										)}

										{/* Parameters */}
										{method.parameters && method.parameters.length > 0 && (
											<div className='mb-3'>
												<h4 className='text-lg font-semibold text-white mb-2'>Parameters</h4>
												<div className='space-y-2'>
													{method.parameters.map((param, paramIndex) => (
														<div
															key={paramIndex}
															className='bg-gray-900/30 rounded p-3 border border-gray-700/30'>
															<div className='flex items-center gap-2 mb-1'>
																<code className='text-blue-400 font-medium'>{param.name}</code>
																{param.optional && <span className='text-xs text-gray-400'>(optional)</span>}
																<code className='text-green-400 text-sm'>{param.type}</code>
															</div>
															{param.description && param.description.trim() && param.description !== "/" && (
																<p className='text-gray-300 text-sm'>{param.description}</p>
															)}
														</div>
													))}
												</div>
											</div>
										)}

										{/* Returns */}
										{method.returns && typeof method.returns === "object" && (
											<div className='mb-3'>
												<h4 className='text-lg font-semibold text-white mb-2'>Returns</h4>
												<div className='bg-gray-900/30 rounded p-3 border border-gray-700/30'>
													<div className='flex items-center gap-2 mb-1'>
														<code className='text-green-400 font-medium'>{method.returns.type}</code>
													</div>
													{method.returns.description &&
														method.returns.description.trim() &&
														method.returns.description !== "/" && (
															<p className='text-gray-300 text-sm'>{method.returns.description}</p>
														)}
												</div>
											</div>
										)}
									</div>
									{method.code && method.code.trim() && method.code !== "/" && (
										<button
											onClick={() => copyCode(method.code)}
											className='flex items-center gap-2 px-3 py-1 bg-gray-700/50 backdrop-blur-sm hover:bg-gray-600/50 text-white rounded transition-colors border border-gray-600/30 ml-4'>
											{copiedCode === method.code ?
												<Check className='w-4 h-4' />
											:	<Copy className='w-4 h-4' />}
											<span className='text-sm'>Copy Example</span>
										</button>
									)}
								</div>
								{method.code && method.code.trim() && method.code !== "/" && (
									<div className='bg-gray-900/50 backdrop-blur-sm rounded p-4 border border-gray-700/30'>
										<h4 className='text-sm font-semibold text-white mb-2'>Example</h4>
										<pre className='text-sm text-gray-300 overflow-x-auto'>
											<code>{method.code}</code>
										</pre>
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			)}

			{/* Events */}
			{currentContent.events && currentContent.events.length > 0 && (
				<div className='mb-8'>
					<h2 className='text-2xl font-bold text-white mb-6'>Events</h2>
					<div className='space-y-4'>
						{currentContent.events.map((event: any, index: number) => (
							<div
								key={index}
								className='bg-gray-800/50 backdrop-blur-sm rounded-lg p-6 border border-gray-700/50 shadow-lg'>
								<h3 className='text-xl font-bold text-white mb-2'>{event.name || "Unnamed Event"}</h3>
								{event.description && event.description.trim() && event.description !== "/" && (
									<p className='text-gray-300 mb-3'>{event.description}</p>
								)}
								{event.parameters &&
									Array.isArray(event.parameters) &&
									event.parameters.length > 0 &&
									event.parameters.some((param: any) => param && typeof param === "string" && param.trim() && param !== "/") && (
										<div className='flex flex-wrap gap-2'>
											{event.parameters
												.filter((param: any) => param && typeof param === "string" && param.trim() && param !== "/")
												.map((param: string, idx: number) => (
													<span
														key={idx}
														className='px-2 py-1 text-xs font-medium bg-blue-900/30 backdrop-blur-sm text-blue-300 rounded border border-blue-700/30'>
														{param}
													</span>
												))}
										</div>
									)}
							</div>
						))}
					</div>
				</div>
			)}

			{/* Navigation */}
			<div className='space-y-4'>
				{/* Core Classes */}
				<div>
					<h3 className='text-lg font-semibold text-white mb-2'>Core Classes</h3>
					<div className='flex flex-wrap gap-2'>
						{["playermanager", "player", "queue"].map((item) => (
							<button
								key={item}
								onClick={() => handleSectionChange(item)}
								className={`px-3 py-1 text-sm rounded transition-colors backdrop-blur-sm border ${
									activeSection === item ?
										"bg-blue-600/80 text-white border-blue-500/50"
									:	"bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 border-gray-600/30"
								}`}>
								{apiContent[item as keyof typeof apiContent]?.title || item}
							</button>
						))}
					</div>
				</div>

				{/* Core Interfaces */}
				<div>
					<h3 className='text-lg font-semibold text-white mb-2'>Core Interfaces</h3>
					<div className='flex flex-wrap gap-2'>
						{[
							"track",
							"searchresult",
							"streaminfo",
							"playeroptions",
							"playermanageroptions",
							"progressbaroptions",
							"playerevents",
							"speechoptions",
							"lyricsoptions",
							"lyricsresult",
							"ttsconfig",
						].map((item) => (
							<button
								key={item}
								onClick={() => handleSectionChange(item)}
								className={`px-3 py-1 text-sm rounded transition-colors backdrop-blur-sm border ${
									activeSection === item ?
										"bg-green-600/80 text-white border-green-500/50"
									:	"bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 border-gray-600/30"
								}`}>
								{apiContent[item as keyof typeof apiContent]?.title || item}
							</button>
						))}
					</div>
				</div>

				{/* Extensions */}
				<div>
					<h3 className='text-lg font-semibold text-white mb-2'>Extensions</h3>
					<div className='flex flex-wrap gap-2'>
						{[
							"lavalinkext",
							"voiceext",
							"lyricsext",
							"extensioncontext",
							"extensionplayrequest",
							"extensionplayresponse",
							"extensionafterplaypayload",
							"extensionstreamrequest",
							"extensionsearchrequest",
						].map((item) => (
							<button
								key={item}
								onClick={() => handleSectionChange(item)}
								className={`px-3 py-1 text-sm rounded transition-colors backdrop-blur-sm border ${
									activeSection === item ?
										"bg-purple-600/80 text-white border-purple-500/50"
									:	"bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 border-gray-600/30"
								}`}>
								{apiContent[item as keyof typeof apiContent]?.title || item}
							</button>
						))}
					</div>
				</div>

				{/* Plugins */}
				<div>
					<h3 className='text-lg font-semibold text-white mb-2'>Plugins</h3>
					<div className='flex flex-wrap gap-2'>
						{[
							"youtubeplugin",
							"soundcloudplugin",
							"spotifyplugin",
							"ttsplugin",
							"sourceplugin",
							"sourceextension",
							"ttspluginoptions",
						].map((item) => (
							<button
								key={item}
								onClick={() => handleSectionChange(item)}
								className={`px-3 py-1 text-sm rounded transition-colors backdrop-blur-sm border ${
									activeSection === item ?
										"bg-red-600/80 text-white border-red-500/50"
									:	"bg-gray-700/50 text-gray-300 hover:bg-gray-600/50 border-gray-600/30"
								}`}>
								{apiContent[item as keyof typeof apiContent]?.title || item}
							</button>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
