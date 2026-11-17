import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const FIRST_RUN_STEPS = 2;

/** 首启两步共用的整页外框：标题、进度、底部操作的位置两步一致。 */
export function OnboardingFrame({ step, title, children, footer }: {
  step: number;
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="flex min-h-screen justify-center bg-background px-4 py-12 sm:px-6 sm:py-24">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-4">
          <ol aria-label={`第 ${step} 步，共 ${FIRST_RUN_STEPS} 步`} className="flex gap-1.5">
            {Array.from({ length: FIRST_RUN_STEPS }, (_, index) => (
              <li key={index} className={cn('h-1 w-8 rounded-full', index < step ? 'bg-primary' : 'bg-secondary')} />
            ))}
          </ol>
          <h1 className="font-display text-display text-foreground">{title}</h1>
        </header>
        {children}
        <footer className="flex items-center justify-end gap-3 border-t border-border pt-6">{footer}</footer>
      </div>
    </main>
  );
}
