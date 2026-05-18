import { useEffect, useState } from 'react';

interface Config { image_storage_root: string }

export function App() {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig);
  }, []);

  if (config === null) return <div style={{ padding: 24 }}>加载中…</div>;
  if (!config.image_storage_root) {
    return <FirstRunConfigPlaceholder onSaved={setConfig} />;
  }
  return <ThreeColumnLayout />;
}

function FirstRunConfigPlaceholder({ onSaved }: { onSaved: (c: Config) => void }) {
  return (
    <div style={{ padding: 24 }}>
      <h1>首次配置（Task D9 替换）</h1>
      <button onClick={() => onSaved({ image_storage_root: '/tmp/images' })}>跳过</button>
    </div>
  );
}

function ThreeColumnLayout() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '20% 50% 30%',
      height: '100vh',
    }}>
      <aside style={{ borderRight: '1px solid var(--color-border)', padding: 16 }}>
        <h2 style={{ fontSize: 'var(--fs-section)' }}>角色列表</h2>
      </aside>
      <main style={{ padding: 16 }}>
        <h2 style={{ fontSize: 'var(--fs-section)' }}>图廊</h2>
      </main>
      <section style={{ borderLeft: '1px solid var(--color-border)', padding: 16 }}>
        <h2 style={{ fontSize: 'var(--fs-section)' }}>规格表单</h2>
      </section>
    </div>
  );
}
