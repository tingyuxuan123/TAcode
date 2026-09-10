import { useRef } from "react";
import type { MouseEvent } from "react";

/**
 * 弹窗遮罩「点外部关闭」的手势判定：
 * 只有按下与松开都落在遮罩上才触发 onClose。
 * 在弹窗内按下、拖到遮罩上松开（或反方向拖拽）不会误关弹窗。
 */
export function useBackdropClose(onClose: () => void) {
  const armedRef = useRef(false);
  return {
    onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
      armedRef.current = event.target === event.currentTarget;
    },
    onClick: (event: MouseEvent<HTMLDivElement>) => {
      if (armedRef.current && event.target === event.currentTarget) onClose();
    },
  };
}
