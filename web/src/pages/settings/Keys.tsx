import { useEffect, useState } from 'react';
import {
  listKeys,
  createKey,
  deleteKey,
  setDefaultKey,
  type KeyView,
  type KeyCreatePayload,
} from '@/api/keys';
import { KeyForm } from './KeyForm';

interface Props {
  mode?: 'onboarding' | 'normal';
  onComplete?: () => void;
}

export function KeysPage({ mode = 'normal', onComplete }: Props = {}) {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [showForm, setShowForm] = useState(mode === 'onboarding');
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    listKeys()
      .then(r => {
        setKeys(r.keys);
      })
      .catch(e => setError(String(e)));

  useEffect(() => { reload(); }, []);

  const onAdd = async (p: KeyCreatePayload) => {
    await createKey(p);
    setShowForm(false);
    reload();
    if (mode === 'onboarding' && onComplete) onComplete();
  };

  const onDelete = async (alias: string) => {
    const confirmed = window.prompt(`删除 Key "${alias}" — 输入别名确认：`);
    if (confirmed !== alias) return;
    try {
      await deleteKey(alias);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const onSetDefault = async (alias: string) => {
    try {
      await setDefaultKey(alias);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl">API Keys</h1>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-stone-900 text-white rounded"
          >
            + 添加 Key
          </button>
        )}
      </div>

      {error && <div className="text-red-600">{error}</div>}

      {showForm && (
        <div className="border p-4 rounded">
          <h2 className="text-lg mb-4">新增 API Key</h2>
          <KeyForm
            onSubmit={onAdd}
            onCancel={() => setShowForm(false)}
            submitLabel={mode === 'onboarding' ? '保存并开始工作' : '保存'}
          />
        </div>
      )}

      <ul className="space-y-3">
        {keys.map(k => (
          <li
            key={k.alias}
            className="border rounded p-4 flex justify-between items-start"
          >
            <div>
              <div className="font-medium">
                {k.alias}
                {k.is_default && (
                  <span className="ml-2 text-xs bg-stone-200 px-2 py-0.5 rounded">默认</span>
                )}
              </div>
              <div className="text-sm text-stone-500">
                {k.provider} · {k.capabilities.join(' / ')} · key: {k.access_key}
              </div>
              {k.notes && <div className="text-sm text-stone-700 mt-1">{k.notes}</div>}
            </div>
            <div className="flex gap-2">
              {!k.is_default && (
                <button
                  type="button"
                  onClick={() => onSetDefault(k.alias)}
                  className="px-3 py-1 text-sm border rounded"
                >
                  设为默认
                </button>
              )}
              <button
                type="button"
                onClick={() => onDelete(k.alias)}
                className="px-3 py-1 text-sm border rounded text-red-600"
              >
                删除
              </button>
            </div>
          </li>
        ))}
        {keys.length === 0 && !showForm && (
          <li className="text-stone-500 text-center py-8">还没有 API Key — 点上方添加一个</li>
        )}
      </ul>
    </div>
  );
}
