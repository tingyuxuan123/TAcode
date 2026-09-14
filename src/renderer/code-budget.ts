/** 同步高亮只用于短代码；超出预算时保留完整原文和浏览器选择/搜索能力。 */
export function canHighlightCode(code: string): boolean {
  if (code.length > 32 * 1024) return false;
  let lines = 1;
  let lineStart = 0;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10) { if (++lines > 512) return false; lineStart = i + 1; }
    else if (i - lineStart >= 2000) return false;
  }
  return true;
}
