/**
 * TACode Runtime 环境变量读取。
 *
 * `TACODE_*` 是唯一前缀。读环境变量统一走本模块，避免各处自己拼前缀。
 */

/** 读取 TACode Runtime 环境变量。 */
export function tacodeEnv(name: string): string | undefined {
  return process.env[`TACODE_${name}`];
}
