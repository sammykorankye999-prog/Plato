import type { Metadata } from 'next';
import './style.css';

export const metadata: Metadata = {
  title: 'Local Login | Secure Workspace',
  description: 'Role-based input workspace',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
