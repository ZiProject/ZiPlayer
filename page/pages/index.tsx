import { Layout } from "@/components/Layout";
import { HeroSection } from "@/components/HeroSection";
import { FeaturesSection } from "@/components/FeaturesSection";
import { AdvancedFeaturesSection } from "@/components/AdvancedFeaturesSection";
import { PluginsSection } from "@/components/PluginsSection";
import { VoiceFeaturesSection } from "@/components/VoiceFeaturesSection";
import { AnimatedBackground } from "@/components/AnimatedBackground";

export default function Home() {
	return (
		<Layout>
			<div className='relative'>
				<AnimatedBackground />
				<HeroSection />
				<FeaturesSection />
				<PluginsSection />
			</div>
		</Layout>
	);
}
