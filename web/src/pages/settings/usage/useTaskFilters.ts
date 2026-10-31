import { useLocation, useSearch } from 'wouter';
import type { UsageTaskFields } from '@/schema/usage';

export type TaskFilterName = keyof UsageTaskFields | 'member';
export type TaskFilterChanges = Partial<Record<TaskFilterName, string>>;

export function useTaskFilters() {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const query = new URLSearchParams(search);
  const fields: UsageTaskFields = {};
  for (const name of ['project', 'model', 'alias', 'kind'] as const) {
    const value = query.get(`task_${name}`);
    if (value) fields[name] = value;
  }
  function change(changes: TaskFilterChanges) {
    const next = new URLSearchParams(search);
    for (const [name, value] of Object.entries(changes)) {
      const key = name === 'member' ? name : `task_${name}`;
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate(`${location}?${next}`);
  }
  return { fields, change };
}
