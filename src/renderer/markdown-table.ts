/**
 * markdown 表格单元格判定（纯逻辑，与 React 解耦，便于确定性测试）。
 *
 * 背景：`.turn` 上有 `overflow-wrap: anywhere`，而 `.markdown table` 是 `width: 100%`。
 * 表格里只要有一列内容很长，浏览器就会把余下所有列一起压缩——短标签列（`completed`、
 * `已核实`）因此被拆成「已核 / 实」两行。识别出这类「不可再压缩的短标签」并在 CSS 里
 * 施加 `white-space: nowrap`，即可让表格把宽度还给它们。
 */

/** 短标签上限：超过这个长度就不再视为不可压缩（12 个 ASCII 字符 ≈「一条终态名」）。 */
export const TIGHT_CELL_MAX_LENGTH = 12;

/**
 * 是否属于「短标签」单元格。
 *
 * 规则：去掉首尾空白后非空、不含任何空白字符、且长度不超过 `TIGHT_CELL_MAX_LENGTH`。
 * 含空格的句子（如 `ts delegation-coordinator.ts:609 （collectReport 收口）`）会被正常换行。
 */
export function isTightTableCell(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > TIGHT_CELL_MAX_LENGTH) return false;
  return !/\s/.test(trimmed);
}
