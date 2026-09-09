/**
 * TACode Runtime 环境变量读取。
 *
 * 数据目录沿用 `TETHER_*` 前缀以兼容历史安装；新代码统一走本模块，
 * 后续迁移到 `TACODE_*` 时只需改这里。
 */

/** 读取 TACode Runtime 环境变量（兼容旧 TETHER_ 前缀）。 */
export function tacodeEnv(name: string): string | undefined {
  return process.env[`TACODE_${name}`] ?? process.env[`TETHER_${name}`];
}
