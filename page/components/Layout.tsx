"use client";

import Link from "next/link";
import { Sidebar } from "./Sidebar";
import { Logo } from "./Logo";
import { PropsWithChildren, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X, Github, BookOpen, Home, Code, Star } from "lucide-react";
import { useRouter } from "next/router";

export function Layout({ children }: PropsWithChildren) {
	const [isScrolled, setIsScrolled] = useState(false);
	const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
	const router = useRouter();

	useEffect(() => {
		const handleScroll = () => {
			setIsScrolled(window.scrollY > 20);
		};

		window.addEventListener("scroll", handleScroll);
		return () => window.removeEventListener("scroll", handleScroll);
	}, []);

	const navItems = [
		{ href: "/", label: "Home", icon: Home },
		{ href: "/showcase", label: "Showcase", icon: Star },
		{ href: "/docs", label: "Documentation", icon: BookOpen },
		{ href: "/api-reference", label: "API Reference", icon: Code },
		{ href: "https://github.com/ZiProject/ZiPlayer", label: "GitHub", icon: Github, external: true },
	];

	return (
		<div className='min-h-screen flex flex-col'>
			{/* Header */}
			<motion.header
				initial={{ y: -100 }}
				animate={{ y: 0 }}
				transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
				className={`sticky top-0 z-50 transition-all duration-300 ${
					isScrolled ? "glass-strong backdrop-blur-xl" : "glass-subtle backdrop-blur-sm"
				}`}>
				<div className='mx-auto max-w-7xl px-4 py-4'>
					<div className='flex items-center justify-between'>
						{/* Logo */}
						<Link
							href='/'
							className='flex items-center gap-3 group'>
							<Logo
								variant='icon'
								size='lg'
								className='group-hover:shadow-brand-500/25 transition-all duration-300'
							/>
							<div>
								<span className='text-xl font-bold text-white group-hover:text-brand-300 transition-colors duration-300'>
									ZiPlayer
								</span>
								<div className='text-xs text-white/60 -mt-1'>Discord Audio Player</div>
							</div>
						</Link>

						{/* Desktop Navigation */}
						<nav className='hidden md:flex items-center gap-1'>
							{navItems.map((item) => (
								<Link
									key={item.href}
									href={item.href}
									target={item.external ? "_blank" : undefined}
									rel={item.external ? "noreferrer" : undefined}
									className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300 ${
										router.pathname === item.href ?
											"bg-brand-500/20 text-brand-300"
										:	"text-white/70 hover:text-white hover:bg-white/10"
									}`}>
									<item.icon size={16} />
									{item.label}
								</Link>
							))}
						</nav>

						{/* Mobile menu button */}
						<button
							onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
							className='md:hidden p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-all duration-300'>
							{isMobileMenuOpen ?
								<X size={24} />
							:	<Menu size={24} />}
						</button>
					</div>
				</div>

				{/* Mobile Navigation */}
				<AnimatePresence>
					{isMobileMenuOpen && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.3 }}
							className='md:hidden border-t border-white/10'>
							<div className='px-4 py-4 space-y-2'>
								{navItems.map((item) => (
									<Link
										key={item.href}
										href={item.href}
										target={item.external ? "_blank" : undefined}
										rel={item.external ? "noreferrer" : undefined}
										onClick={() => setIsMobileMenuOpen(false)}
										className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-300 ${
											router.pathname === item.href ?
												"bg-brand-500/20 text-brand-300"
											:	"text-white/70 hover:text-white hover:bg-white/10"
										}`}>
										<item.icon size={18} />
										{item.label}
									</Link>
								))}
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</motion.header>

			{/* Main content */}
			<main className='flex-1'>{children}</main>

			{/* Footer */}
			<motion.footer
				initial={{ opacity: 0 }}
				whileInView={{ opacity: 1 }}
				viewport={{ once: true }}
				transition={{ duration: 0.6 }}
				className='border-t border-white/10 bg-dark-900/50 backdrop-blur-sm'>
				<div className='mx-auto max-w-7xl px-4 py-12'>
					<div className='grid md:grid-cols-4 gap-8'>
						{/* Brand */}
						<div className='space-y-4'>
							<div className='flex items-center gap-3'>
								<Logo
									variant='icon'
									size='md'
									animated={false}
								/>
								<span className='text-xl font-bold text-white'>ZiPlayer</span>
							</div>
							<p className='text-white/60 text-sm leading-relaxed'>
								Powerful Discord audio player with flexible plugin system and high performance.
							</p>
						</div>

						{/* Quick Links */}
						<div className='space-y-4'>
							<h3 className='text-white font-semibold'>Quick Links</h3>
							<div className='space-y-2'>
								<Link
									href='/docs'
									className='block text-white/60 hover:text-brand-300 transition-colors duration-200'>
									Documentation
								</Link>
								<Link
									href='/docs/getting-started'
									className='block text-white/60 hover:text-brand-300 transition-colors duration-200'>
									Get Started
								</Link>
								<Link
									href='/docs/examples'
									className='block text-white/60 hover:text-brand-300 transition-colors duration-200'>
									Examples
								</Link>
								<Link
									href='/api-reference'
									className='block text-white/60 hover:text-brand-300 transition-colors duration-200'>
									API Reference
								</Link>
							</div>
						</div>

						{/* Community */}
						<div className='space-y-4'>
							<h3 className='text-white font-semibold'>Community</h3>
							<div className='space-y-2'>
								<a
									href='https://github.com/ZiProject/ZiPlayer'
									target='_blank'
									rel='noopener noreferrer'
									className='block text-white/60 hover:text-brand-300 transition-colors duration-200'>
									GitHub
								</a>
								<a
									href='https://discord.gg/zaskhD7PTW'
									target='_blank'
									rel='noopener noreferrer'
									className='block text-white/60 hover:text-brand-300 transition-colors duration-200'>
									Discord
								</a>
							</div>
						</div>

						{/* Legal */}
						<div className='space-y-4'>
							<h3 className='text-white font-semibold'>Legal</h3>
							<div className='space-y-2'>
								<Link
									href='/privacy'
									className='block text-white/60 hover:text-brand-300 transition-colors duration-200'>
									Privacy Policy
								</Link>
								<Link
									href='/terms'
									className='block text-white/60 hover:text-brand-300 transition-colors duration-200'>
									Terms of Service
								</Link>
							</div>
						</div>
					</div>

					<div className='border-t border-white/10 mt-8 pt-8 flex flex-col md:flex-row items-center justify-between'>
						<span className='text-white/60 text-sm'>© {new Date().getFullYear()} ZiPlayer. All rights reserved.</span>
						<span className='text-white/60 text-sm mt-2 md:mt-0'>Built with Next.js and ❤️</span>
					</div>
				</div>
			</motion.footer>
		</div>
	);
}
