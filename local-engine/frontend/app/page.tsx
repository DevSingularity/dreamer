import LandingPage from "@/components/landing-page/LandingPage";
import { JsonLd } from "@/components/seo/JsonLd";

export default function Home() {
  return (
    <>
      <JsonLd />
      <LandingPage />
    </>
  );
}
