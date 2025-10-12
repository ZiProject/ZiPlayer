"use client";

import { motion } from "framer-motion";
import Image from "next/image";

interface LogoProps {
	variant?: "icon" | "full";
	size?: "sm" | "md" | "lg" | "xl";
	className?: string;
	animated?: boolean;
}

export function Logo({ variant = "icon", size = "md", className = "", animated = true }: LogoProps) {
	const sizeClasses = {
		sm: variant === "icon" ? "h-6 w-6" : "h-12",
		md: variant === "icon" ? "h-8 w-8" : "h-16",
		lg: variant === "icon" ? "h-10 w-10" : "h-20",
		xl: variant === "icon" ? "h-12 w-12" : "h-24",
	};

	const logoUrl =
		variant === "icon" ?
			"https://github.com/user-attachments/assets/4e7855e8-6044-4c49-90bd-867436173b4f"
		:	"https://github.com/user-attachments/assets/b85a4976-ef7d-432a-9cae-36b11486ac0f";

	const LogoComponent = animated ? motion.div : "div";
	const logoProps =
		animated ?
			{
				whileHover: { scale: 1.05 },
				whileTap: { scale: 0.95 },
				transition: { duration: 0.2 },
			}
		:	{};

	return (
		<LogoComponent
			{...logoProps}
			className={`relative ${className}`}>
			<Image
				src={logoUrl}
				alt={`ZiPlayer ${variant === "icon" ? "Icon" : "Logo"}`}
				width={variant === "icon" ? 40 : 200}
				height={variant === "icon" ? 40 : 60}
				className={`${sizeClasses[size]} ${variant === "icon" ? "rounded-lg" : ""} object-contain`}
				priority
			/>
			{animated && variant === "icon" && (
				<motion.div
					className='absolute inset-0 rounded-lg bg-gradient-to-br from-brand-400/20 to-brand-500/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300'
					animate={{
						scale: [1, 1.1, 1],
						opacity: [0, 0.3, 0],
					}}
					transition={{
						duration: 2,
						repeat: Infinity,
						ease: "easeInOut",
					}}
				/>
			)}
		</LogoComponent>
	);
}
