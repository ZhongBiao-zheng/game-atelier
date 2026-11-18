/** 与 src/character_workflow/lib/schemas.py 的 AccentThemes / AccentThemesUpdate 同步。 */
import type { AccentColors, AccentPreset } from '@/lib/accentPresets';

export const ACCENT_THEME_NAME_MAX = 12;
export const ACCENT_USER_THEME_MAX = 24;

export interface AccentUserTheme extends AccentColors {
  /** `u-` + 8–32 位小写字母数字 */
  id: string;
  name: string;
}

/** 改过的内置主题：四色必填；name 只在改过名时有值。 */
export interface AccentBuiltinOverride extends AccentColors {
  name?: string | null;
}

export interface AccentThemesBody {
  /** 内置主题 id 或用户主题 id */
  active: string;
  /** 改过颜色或名称的内置主题 */
  overrides: Partial<Record<AccentPreset, AccentBuiltinOverride>>;
  custom: AccentUserTheme[];
}

/** `.config/accent-themes.json`；revision 0 = 从未保存。 */
export interface AccentThemes extends AccentThemesBody {
  schema_version: 1;
  revision: number;
  updated_at?: string | null;
}

export interface AccentThemesUpdate extends AccentThemesBody {
  expected_revision: number;
}
