export interface AccentColors {
  primary: string;
  brand2: string;
  brand3: string;
  brand4: string;
}

export const ACCENT_PRESETS = [
  { id: 'lime', name: '青柠', primary: '#D4F53C', brand2: '#6FD6F0', brand3: '#F5D06A', brand4: '#A99FF5' },
  { id: 'violet', name: '电光紫', primary: '#A98BFF', brand2: '#7DD3FC', brand3: '#FCD34D', brand4: '#F9A8D4' },
  { id: 'orange', name: '信号橙', primary: '#FF6B2C', brand2: '#7DD3FC', brand3: '#FCD34D', brand4: '#C4B5FD' },
  { id: 'cyan', name: '冰川青', primary: '#3EE6D0', brand2: '#A78BFA', brand3: '#FCD34D', brand4: '#FDA4AF' },
  { id: 'pink', name: '珊瑚粉', primary: '#FF5C8A', brand2: '#C4B5FD', brand3: '#FCD34D', brand4: '#86EFAC' },
  { id: 'yellow', name: '柠檬黄', primary: '#FFD23F', brand2: '#93C5FD', brand3: '#FDBA74', brand4: '#F9A8D4' },
  { id: 'blue', name: '钴蓝', primary: '#6F8BFF', brand2: '#67E8F9', brand3: '#FDBA74', brand4: '#F9A8D4' },
] as const;
export type AccentPreset = typeof ACCENT_PRESETS[number]['id'];
