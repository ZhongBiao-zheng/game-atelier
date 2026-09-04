import { connectionFetch } from '@/api/connection';
import { useEffect, useState } from 'react';
import { FolderOpen, FolderEdit, AlertCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { chooseFolder } from '@/api/folders';
import { setDataRoot } from '@/api/onboarding';
import { cn } from '@/lib/utils';

interface Props { onSaved: (root: string) => void }

const DEFAULT_PATH = '~/Pictures/character-assets';

export function FirstRunConfig({ onSaved }: Props) {
  const [mode, setMode] = useState<'default' | 'custom'>('default');
  const [customPath, setCustomPath] = useState('');
  const [defaultPath, setDefaultPath] = useState(DEFAULT_PATH);
  const [submitting, setSubmitting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    connectionFetch('/api/home').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.home) setDefaultPath(`${d.home}/Pictures/character-assets`);
    }).catch(() => {});
  }, []);

  const effectivePath = mode === 'default' ? defaultPath : customPath.trim();

  async function pickCustomPath() {
    setChoosing(true);
    setError(null);
    try {
      const picked = await chooseFolder('选择数据目录', customPath || defaultPath);
      if (picked) {
        setCustomPath(picked);
        setMode('custom');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChoosing(false);
    }
  }

  async function submit() {
    if (!effectivePath) return;
    setSubmitting(true);
    setError(null);
    try {
      const saved = await setDataRoot(effectivePath);
      onSaved(saved.data_root || effectivePath);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-background">
      <div className="w-full max-w-[560px]">
        <div className="flex items-center gap-3 mb-3">
          <Sparkles className="size-5 text-primary" />
          <h1 className="font-display text-display tracking-tight">角色资产工作流</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-10 leading-relaxed">
          选一个目录存放你的出图。可以用默认目录，也可以手动指定。
        </p>

        <div className="space-y-3 mb-6">
          <OptionCard
            active={mode === 'default'}
            onClick={() => setMode('default')}
            icon={<FolderOpen className="size-4" />}
            title="使用默认目录"
            badge="推荐"
          >
            <div className="font-mono text-xs text-muted-foreground mt-1 truncate">{defaultPath}</div>
          </OptionCard>

          <OptionCard
            active={mode === 'custom'}
            onClick={() => { void pickCustomPath(); }}
            icon={<FolderEdit className="size-4" />}
            title="选择数据目录"
          >
            <div className="mt-2 min-w-0 truncate rounded-md border border-input bg-background/35 px-3 py-2 font-mono text-xs text-muted-foreground">
              {choosing ? '选择中...' : customPath || '点击选择文件夹'}
            </div>
          </OptionCard>
        </div>

        <Button
          onClick={submit}
          disabled={!effectivePath || submitting || choosing}
          className="w-full"
          size="lg"
        >
          {submitting ? '保存中…' : '开始使用'}
        </Button>

        <p className="text-xs text-muted-foreground mt-3 text-center">
          默认目录不存在会自动创建；自定义目录请从系统文件夹选择器中选择。
        </p>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function OptionCard({
  active, onClick, icon, title, badge, children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-lg border bg-card px-4 py-3 transition-all cursor-pointer',
        'hover:border-primary/40',
        active
          ? 'border-primary ring-2 ring-primary/20'
          : 'border-border',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className={cn('shrink-0', active ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>
        <span className="text-sm font-medium flex-1">{title}</span>
        {badge && (
          <span className="text-xs font-medium px-1.5 py-0.5 rounded-sm bg-primary/15 text-primary uppercase tracking-wider">
            {badge}
          </span>
        )}
        <span className={cn(
          'size-4 rounded-full border-2 shrink-0 grid place-items-center transition-colors',
          active ? 'border-primary' : 'border-muted-foreground/40',
        )}>
          {active && <span className="size-1.5 rounded-full bg-primary" />}
        </span>
      </div>
      {children && <div>{children}</div>}
    </button>
  );
}
