import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/** 只开 react-hooks 两条规则，不开通用 lint 集。
 *
 *  仓库此前没有 ESLint，`pnpm lint` 只是 `tsc -b --noEmit`，于是 react-hooks/exhaustive-deps
 *  从未跑过 —— 画布一个文件里就有 55 项手维护的依赖数组。这类缺口 tsc 完全看不见，改一行就会踩。
 *
 *  刻意不引入 recommended 规则集：一次性铺开几百条风格告警会让这道门禁被整体忽略，而 hooks
 *  依赖是唯一「不跑就会静默出错」的那类。要加别的规则，等这两条长期保持零告警之后再说。 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
