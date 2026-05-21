import type { Metadata } from "next";
import { DM_Mono, Syne } from "next/font/google";

const dmMono = DM_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-dm-mono",
});

const syne = Syne({
  weight: ["700", "800"],
  subsets: ["latin"],
  variable: "--font-syne",
});

export const metadata: Metadata = {
  title: "Square Hunter · Euphoria Analytics",
  description: "Live on-chain tap trade heatmap for Euphoria Finance on MegaETH",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${dmMono.variable} ${syne.variable}`}>
        {children}
      </body>
    </html>
  );
}