import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '招聘 IM Agent · Playground',
  description: '蓝领招聘 C 端智能接待 Agent 的本地调试台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
