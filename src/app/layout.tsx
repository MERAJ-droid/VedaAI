import type { Metadata } from 'next';
import { Bricolage_Grotesque } from 'next/font/google';
import './globals.css';
import { TooltipProvider } from '@/components/ui/tooltip';

const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-bricolage',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'VedaAI — Assessment Extraction',
  description: 'Upload question papers and answer sheets for AI-powered extraction and mapping.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={bricolage.variable}>
      <body
        className={bricolage.className}
        style={{
          background: 'linear-gradient(145deg, #FFFFFF 0%, #E9E5E5 100%)',
          minHeight: '100vh',
        }}
      >
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </body>
    </html>
  );
}
