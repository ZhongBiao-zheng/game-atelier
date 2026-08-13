// web 的 tsconfig 刻意只装浏览器类型（没有 @types/node）——但 capabilityMatrix.test.ts 必须用
// fs 读仓库根的能力矩阵真值表：fixture 在 vite root（web/）之外，走 JSON import 会被 fs.allow 拦。
// 只声明那一个读文件签名 + import.meta.dirname，不为一个测试把整套 node 类型拉进前端类型域。
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf-8'): string;
}

interface ImportMeta {
  /** 当前模块所在目录的绝对路径（vite-node 与 Node ≥20.11 都提供）。 */
  readonly dirname: string;
}
