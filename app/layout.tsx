import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = { title: 'Gathered · Find your group', description: 'A calm way to find a group that fits your season of life.', generator: 'v0.app' }
export const viewport: Viewport = { colorScheme: 'light', themeColor: '#fbfcf8' }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="antialiased">{children}{process.env.NODE_ENV === 'production' && <Analytics />}</body></html>
}
