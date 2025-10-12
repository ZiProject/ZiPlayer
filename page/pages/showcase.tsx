import { AnimatedBackground } from "@/components/AnimatedBackground";
import { Layout } from "@/components/Layout";
import { ShowcaseSection } from "@/components/ShowcaseSection";

export default function Showcase() {
	return (
		<Layout>
			<div className='relative'>
				<AnimatedBackground />
				<ShowcaseSection />
			</div>
		</Layout>
	);
}
