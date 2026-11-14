// ESLint 只检查配置文件所在目录之内的文件，所以插件界面源码在这里接上与 web/ 相同的规则。
import { reactHooksRules } from '../web/eslint.config.js';

export default [
  { ignores: ['*/package/**'] },
  reactHooksRules(['**/*.{ts,tsx}']),
];
