import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const publicUrl = process.env.OXYGEN_REVIEW_PUBLIC_URL;

export const metadata: Metadata = {
  title: 'Oxygen Review',
  description:
    'Review evidence-grounded summaries and insights produced by Oxygen.',
  metadataBase: publicUrl ? new URL(publicUrl) : undefined,
  openGraph: {
    title: 'Oxygen Review',
    description: 'Trace evidence. Refine insight.',
    url: publicUrl,
    siteName: 'Oxygen Review',
    images: [
      {
        url: '/og.png',
        width: 1733,
        height: 907,
        alt: 'Oxygen Review evidence-linked human review workspace',
      },
    ],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Oxygen Review',
    description: 'Trace evidence. Refine insight.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
