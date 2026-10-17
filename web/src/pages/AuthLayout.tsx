import type { ReactNode } from 'react';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark">J</span>JobsMato ATS</div>
        <h1>{title}</h1>
        {subtitle ? <p className="sub">{subtitle}</p> : <div style={{ height: 16 }} />}
        {children}
      </div>
    </div>
  );
}
