import type { ReactNode } from 'react';

/** 首启整页外框：标题、正文、底部操作（存放位置、连接一个模型两页共用）。 */
export function OnboardingFrame({ title, children, footer }: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="flex min-h-screen justify-center bg-background px-4 py-12 sm:px-6 sm:py-24">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <header>
          <h1 className="font-display text-display text-foreground">{title}</h1>
        </header>
        {children}
        <footer className="flex items-center justify-end gap-3 border-t border-border pt-6">{footer}</footer>
      </div>
    </main>
  );
}
