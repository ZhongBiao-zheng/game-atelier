export async function chooseFolder(title: string, initialPath?: string): Promise<string | null> {
  const r = await fetch('/api/folder-picker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, initial_path: initialPath || null }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`choose folder failed ${r.status}: ${body}`);
  }
  const data = await r.json();
  return data.path ?? null;
}
