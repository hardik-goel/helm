import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Helm',
  description: 'Local-first mission control for autonomous Claude Code agents.',
};

export const viewport: Viewport = {
  themeColor: '#0B0D12',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
