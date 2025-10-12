import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ExternalLink, Package, Star, Download, Users, Calendar } from "lucide-react";

interface ShowcaseData {
	name: string;
	description: string;
	version: string;
	repository: {
		url: string;
		type: string;
	};
	packages: Array<{
		name: string;
		description: string;
		version: string;
		npm: string;
		features: string[];
	}>;
	examples: Array<{
		name: string;
		description: string;
		url: string;
		features: string[];
	}>;
	stats: {
		downloads: string;
		stars: string;
		contributors: string;
		lastUpdated: string;
	};
	links: {
		documentation: string;
		apiReference: string;
		examples: string;
		github: string;
		npm: string;
	};
}

export function ShowcaseSection() {
	const [showcaseData, setShowcaseData] = useState<ShowcaseData | null>(null);
	const [activeTab, setActiveTab] = useState<"packages" | "examples">("packages");

	useEffect(() => {
		// Load showcase data
		fetch("/showcase.json")
			.then((res) => res.json())
			.then((data) => setShowcaseData(data))
			.catch((err) => console.error("Failed to load showcase data:", err));
	}, []);

	if (!showcaseData) {
		return (
			<div className='min-h-screen flex items-center justify-center'>
				<div className='text-center'>
					<div className='animate-pulse'>
						<div className='h-8 bg-gray-700 rounded w-64 mx-auto mb-4'></div>
						<div className='h-4 bg-gray-700 rounded w-96 mx-auto'></div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className='min-h-screen'>
			<div className='container mx-auto px-4 py-20'>
				{/* Header */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6 }}
					viewport={{ once: true }}
					className='text-center mb-16'>
					<h2 className='text-4xl md:text-5xl font-bold text-white mb-6'>Showcase</h2>
					<p className='text-xl text-gray-300 max-w-3xl mx-auto'>
						Explore {showcaseData.name} packages and examples - a powerful Discord player system with flexible plugin architecture
					</p>
				</motion.div>

				{/* Stats */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, delay: 0.2 }}
					viewport={{ once: true }}
					className='grid grid-cols-2 md:grid-cols-4 gap-6 mb-16'>
					<div className='bg-white/10 backdrop-blur-sm rounded-xl p-6 text-center'>
						<Download className='w-8 h-8 text-blue-400 mx-auto mb-2' />
						<div className='text-2xl font-bold text-white'>{showcaseData.stats.downloads}</div>
						<div className='text-gray-300'>Downloads</div>
					</div>
					<div className='bg-white/10 backdrop-blur-sm rounded-xl p-6 text-center'>
						<Star className='w-8 h-8 text-yellow-400 mx-auto mb-2' />
						<div className='text-2xl font-bold text-white'>{showcaseData.stats.stars}</div>
						<div className='text-gray-300'>GitHub Stars</div>
					</div>
					<div className='bg-white/10 backdrop-blur-sm rounded-xl p-6 text-center'>
						<Users className='w-8 h-8 text-green-400 mx-auto mb-2' />
						<div className='text-2xl font-bold text-white'>{showcaseData.stats.contributors}</div>
						<div className='text-gray-300'>Contributors</div>
					</div>
					<div className='bg-white/10 backdrop-blur-sm rounded-xl p-6 text-center'>
						<Calendar className='w-8 h-8 text-purple-400 mx-auto mb-2' />
						<div className='text-2xl font-bold text-white'>{showcaseData.stats.lastUpdated}</div>
						<div className='text-gray-300'>Last Updated</div>
					</div>
				</motion.div>

				{/* Tabs */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, delay: 0.4 }}
					viewport={{ once: true }}
					className='mb-8'>
					<div className='flex justify-center mb-8'>
						<div className='bg-white/10 backdrop-blur-sm rounded-xl p-2'>
							<button
								onClick={() => setActiveTab("packages")}
								className={`px-6 py-3 rounded-lg font-medium transition-all ${
									activeTab === "packages" ? "bg-white text-slate-900" : "text-white hover:bg-white/20"
								}`}>
								<Package className='w-5 h-5 inline mr-2' />
								Packages
							</button>
							<button
								onClick={() => setActiveTab("examples")}
								className={`px-6 py-3 rounded-lg font-medium transition-all ${
									activeTab === "examples" ? "bg-white text-slate-900" : "text-white hover:bg-white/20"
								}`}>
								<ExternalLink className='w-5 h-5 inline mr-2' />
								Examples
							</button>
						</div>
					</div>
				</motion.div>

				{/* Content */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, delay: 0.6 }}
					viewport={{ once: true }}>
					{activeTab === "packages" && (
						<div className='grid md:grid-cols-2 lg:grid-cols-3 gap-8'>
							{showcaseData.packages.map((pkg, index) => (
								<motion.div
									key={pkg.name}
									initial={{ opacity: 0, y: 20 }}
									whileInView={{ opacity: 1, y: 0 }}
									transition={{ duration: 0.6, delay: index * 0.1 }}
									viewport={{ once: true }}
									className='bg-white/10 backdrop-blur-sm rounded-xl p-6 hover:bg-white/20 transition-all group'>
									<div className='flex items-center justify-between mb-4'>
										<h3 className='text-xl font-bold text-white'>{pkg.name}</h3>
										<span className='bg-blue-500/20 text-blue-300 px-3 py-1 rounded-full text-sm'>v{pkg.version}</span>
									</div>
									<p className='text-gray-300 mb-4'>{pkg.description}</p>
									<div className='mb-4'>
										<h4 className='text-white font-semibold mb-2'>Features:</h4>
										<ul className='space-y-1'>
											{pkg.features.map((feature, idx) => (
												<li
													key={idx}
													className='text-gray-300 text-sm flex items-center'>
													<span className='w-2 h-2 bg-green-400 rounded-full mr-2'></span>
													{feature}
												</li>
											))}
										</ul>
									</div>
									<a
										href={pkg.npm}
										target='_blank'
										rel='noopener noreferrer'
										className='inline-flex items-center text-blue-400 hover:text-blue-300 transition-colors'>
										<Package className='w-4 h-4 mr-2' />
										View on NPM
										<ExternalLink className='w-4 h-4 ml-2' />
									</a>
								</motion.div>
							))}
						</div>
					)}

					{activeTab === "examples" && (
						<div className='grid md:grid-cols-2 lg:grid-cols-3 gap-8'>
							{showcaseData.examples.map((example, index) => (
								<motion.div
									key={example.name}
									initial={{ opacity: 0, y: 20 }}
									whileInView={{ opacity: 1, y: 0 }}
									transition={{ duration: 0.6, delay: index * 0.1 }}
									viewport={{ once: true }}
									className='bg-white/10 backdrop-blur-sm rounded-xl p-6 hover:bg-white/20 transition-all group relative'>
									{/* View Example button positioned at top right */}
									<a
										href={example.url}
										target='_blank'
										rel='noopener noreferrer'
										className='absolute top-4 right-4 inline-flex items-center text-white hover:text-gray-200 transition-colors bg-white/20 hover:bg-white/30 px-3 py-1 rounded-lg text-sm'>
										<ExternalLink className='w-4 h-4 mr-1' />
										View Example
									</a>
									<h3 className='text-xl font-bold text-white mb-4 pr-20'>{example.name}</h3>
									<p className='text-gray-300 mb-4'>{example.description}</p>
									<div className='mb-4'>
										<h4 className='text-white font-semibold mb-2'>Features:</h4>
										<ul className='space-y-1'>
											{example.features.map((feature, idx) => (
												<li
													key={idx}
													className='text-gray-300 text-sm flex items-center'>
													<span className='w-2 h-2 bg-purple-400 rounded-full mr-2'></span>
													{feature}
												</li>
											))}
										</ul>
									</div>
								</motion.div>
							))}
						</div>
					)}
				</motion.div>

				{/* Quick Links */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, delay: 0.8 }}
					viewport={{ once: true }}
					className='mt-16 text-center'>
					<h3 className='text-2xl font-bold text-white mb-8'>Quick Links</h3>
					<div className='flex flex-wrap justify-center gap-4'>
						<a
							href={showcaseData.links.github}
							target='_blank'
							rel='noopener noreferrer'
							className='bg-white/10 backdrop-blur-sm hover:bg-white/20 text-white px-6 py-3 rounded-xl transition-all flex items-center'>
							<ExternalLink className='w-5 h-5 mr-2' />
							GitHub Repository
						</a>
						<a
							href={showcaseData.links.npm}
							target='_blank'
							rel='noopener noreferrer'
							className='bg-white/10 backdrop-blur-sm hover:bg-white/20 text-white px-6 py-3 rounded-xl transition-all flex items-center'>
							<Package className='w-5 h-5 mr-2' />
							NPM Package
						</a>
						<a
							href={showcaseData.links.documentation}
							className='bg-white/10 backdrop-blur-sm hover:bg-white/20 text-white px-6 py-3 rounded-xl transition-all flex items-center'>
							<ExternalLink className='w-5 h-5 mr-2' />
							Documentation
						</a>
						<a
							href={`${showcaseData.links.github}/blob/main/page/public/showcase.json`}
							target='_blank'
							rel='noopener noreferrer'
							className='bg-gradient-to-r from-blue-500/20 to-purple-500/20 backdrop-blur-sm hover:from-blue-500/30 hover:to-purple-500/30 text-white px-6 py-3 rounded-xl transition-all flex items-center border border-white/20'>
							<Star className='w-5 h-5 mr-2' />
							Add Your Showcase
						</a>
					</div>
				</motion.div>
			</div>
		</div>
	);
}
