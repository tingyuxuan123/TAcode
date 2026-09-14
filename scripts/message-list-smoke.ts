import type { BrowserWindow } from "electron";
import assert from "node:assert/strict";

/**
 * 消息列表窗口化回归：在真实 Electron 窗口里跑 `scripts/fixtures/message-list.tsx`
 * （生产 `MessageList` + `useFollowScroll` + `AssistantTurn`），断言：
 *
 * 1. 150 轮历史只挂载视口附近的少量条目（窗口化生效）；
 * 2. 挂载的条目按顺序排列、互不重叠（测量高度正确）；
 * 3. 滚到底部时最后一条可见、且底部留白恰好是列表内边距（总高度正确）；
 * 4. 跳转到早期锚点：目标条目自动挂载并落在视口顶部（虚拟滚动定位）；
 * 5. 跟随模式下来新内容时保持在底部（与 useFollowScroll 的协作）。
 */

interface ItemRect {
  top: number;
  bottom: number;
  height: number;
}

interface State {
  viewport: { top: number; clientHeight: number; scrollTop: number; scrollHeight: number };
  itemCount: number;
  rects: ItemRect[];
  anchors: string[];
  /** 诊断用：虚拟容器与内容块的几何信息。 */
  boxes: {
    containerTop: number;
    containerHeight: number;
    containerStyleHeight: string;
    wrapperTop: number;
    wrapperHeight: number;
    lastItemBottom: number;
  };
}

export async function verifyMessageList(win: BrowserWindow): Promise<void> {
  const evaluate = (script: string) => win.webContents.executeJavaScript(script, true);

  // 页面脚本是 ES module，React 挂载发生在其后：先等 fixture 就绪再断言。
  const ready = async (): Promise<boolean> => {
    try {
      return await evaluate("Boolean(window.__messageListFixture && document.querySelector('.conversation'))");
    } catch {
      return false;
    }
  };
  const readyDeadline = Date.now() + 8000;
  while (!(await ready())) {
    if (Date.now() > readyDeadline) throw new Error("探针页面未就绪：fixture 或滚动容器不存在");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const read = (): Promise<State> => evaluate(`(() => {
    const box = document.querySelector('.conversation');
    const items = Array.from(document.querySelectorAll('.message-item'));
    return {
      viewport: {
        top: box.getBoundingClientRect().top,
        clientHeight: box.clientHeight,
        scrollTop: box.scrollTop,
        scrollHeight: box.scrollHeight,
      },
      itemCount: items.length,
      rects: items.map((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
      anchors: Array.from(document.querySelectorAll('.turn[data-scroll-anchor]')).map((el) => el.dataset.scrollAnchor),
      boxes: (() => {
        const wrapper = document.querySelector('.messages');
        const container = wrapper?.firstElementChild;
        const last = items[items.length - 1];
        const round = (value) => (typeof value === "number" ? Math.round(value * 10) / 10 : -1);
        return {
          containerTop: round(container?.getBoundingClientRect().top),
          containerHeight: round(container?.getBoundingClientRect().height),
          containerStyleHeight: container?.style.height ?? "?",
          wrapperTop: round(wrapper?.getBoundingClientRect().top),
          wrapperHeight: round(wrapper?.getBoundingClientRect().height),
          lastItemBottom: round(last?.getBoundingClientRect().bottom),
        };
      })(),
    };
  })()`);

  const wait = async (predicate: (state: State) => boolean, label: string): Promise<State> => {
    const deadline = Date.now() + 5000;
    let state = await read();
    while (Date.now() < deadline) {
      state = await read();
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`消息列表未到达期望状态（${label}）：${JSON.stringify({ itemCount: state.itemCount, viewport: state.viewport, boxes: state.boxes })}`);
  };

  /** 当前距底距离（px）：> 0 表示停在上面，0 表示贴着最新。 */
  const bottomGap = (): Promise<number> => evaluate(`(() => {
    const box = document.querySelector('.conversation');
    return Math.round(box.scrollHeight - box.scrollTop - box.clientHeight);
  })()`);

  /**
   * 模拟一次真实滚动输入：先派发方向明确的 wheel 事件（生产监听器据此判定用户意图），
   * 再把浏览器会写的 scrollTop 位移一并应用——合成的 wheel 事件本身不会滚动内容。
   * 返回这次位移之后距底的距离。
   */
  const gesture = (direction: "up" | "down", pixels: number): Promise<number> => evaluate(`(() => {
    const box = document.querySelector('.conversation');
    const deltaY = ${direction === "up" ? -pixels : pixels};
    box.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    box.scrollTop += deltaY;
    return Math.round(box.scrollHeight - box.scrollTop - box.clientHeight);
  })()`);

  const turns = await evaluate("window.__messageListFixture.turns");

  // 1. 窗口化：挂载条目数量级远小于历史轮数。
  const initial = await wait(
    (state) => state.itemCount > 0 && state.viewport.scrollHeight > state.viewport.clientHeight * 4,
    "首次挂载",
  );  assert(
    initial.itemCount < 40,
    `窗口化未生效：${turns} 轮历史挂载了 ${initial.itemCount} 个条目`,
  );
  assert(
    initial.viewport.scrollHeight > initial.viewport.clientHeight * 4,
    `探针窗口太矮，滚动场景不成立（scrollHeight=${initial.viewport.scrollHeight}）`,
  );
  // 初始应停在底部（新会话进入即跟随最新）。
  const pinned = await wait(
    (state) => state.viewport.scrollHeight - state.viewport.scrollTop - state.viewport.clientHeight <= 4,
    "初始停在底部",
  );
  assert(
    pinned.viewport.scrollHeight - pinned.viewport.scrollTop - pinned.viewport.clientHeight <= 4,
    `初始未停在底部：${JSON.stringify(pinned.viewport)}`,
  );

  // 2. 窗口化容器不得吞掉指针事件/文本选择：否则消息里的链接、按钮、复制与选中全失效。
  const interactivity = await evaluate(`(() => {
    const wrapper = document.querySelector('.messages');
    const container = wrapper.firstElementChild;
    const items = Array.from(document.querySelectorAll('.message-item'));
    const item = items[items.length - 1];
    const box = document.querySelector('.conversation');
    const rect = item.getBoundingClientRect();
    const viewport = box.getBoundingClientRect();
    const y = Math.min(viewport.bottom - 4, Math.max(viewport.top + 4, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
    return {
      container: getComputedStyle(container).pointerEvents,
      containerInline: container.getAttribute('style'),
      item: getComputedStyle(item).pointerEvents,
      box: getComputedStyle(box).pointerEvents,
      selectable: getComputedStyle(item).userSelect,
      hitClass: hit ? hit.className || hit.tagName : null,
      hitInsideMessage: Boolean(hit && wrapper.contains(hit)),
    };
  })()`);
  assert(
    interactivity.container !== "none" && interactivity.item !== "none" && interactivity.box !== "none",
    `窗口化容器吞掉了指针事件：${JSON.stringify(interactivity)}`,
  );
  assert(
    interactivity.selectable !== "none",
    `消息内容不可选中（user-select: none）：${JSON.stringify(interactivity)}`,
  );
  assert(
    interactivity.hitInsideMessage,
    `消息区域命中测试失败，指针事件没有落到内容上：${JSON.stringify(interactivity)}`,
  );

  // 3. 顺序与不重叠。
  const ordered = await wait((state) => state.itemCount >= 2, "多条目挂载");
  for (let index = 1; index < ordered.rects.length; index += 1) {
    const previous = ordered.rects[index - 1]!;
    const current = ordered.rects[index]!;
    assert(
      current.top >= previous.bottom - 1,
      `第 ${index} 个条目与上一个重叠：${JSON.stringify({ previous, current })}`,
    );
  }
  assert(
    ordered.rects.every((rect) => rect.height > 0),
    "存在零高度条目，说明条目测量失败",
  );
  // 轮次间距：窗口化把每个条目包了一层，如果 `.turn` 的末条规则误命中每一条，
  // 间距会从 22px 掉到 8px（`.turn:last-child` 的经典坑）。
  const gaps = await evaluate(`(() => {
    const turns = Array.from(document.querySelectorAll('.message-item .turn'));
    return turns.slice(1).map((el, index) => {
      const previous = turns[index];
      return Math.round(el.getBoundingClientRect().top - previous.getBoundingClientRect().bottom);
    });
  })()`);
  assert(
    gaps.every((gap: number) => gap >= 18),
    `轮次间距异常（应为 22px，说明末条规则命中了所有条目）：${JSON.stringify(gaps)}`,
  );

  // 4. 底部留白正好是列表内边距，说明总高度与真实高度一致。
  const bottomMost = await evaluate(`(() => {
    const box = document.querySelector('.conversation');
    box.scrollTop = box.scrollHeight;
    return true;
  })()`);
  assert(bottomMost === true, "滚动到底部失败");
  const settled = await wait(
    (state) => state.anchors.includes(`assistant-${turns - 1}`),
    "底部最后一条挂载",
  );
  const lastRect = settled.rects[settled.rects.length - 1]!;
  const gap = settled.viewport.top + settled.viewport.clientHeight - lastRect.bottom;
  assert(
    Math.abs(gap - 20) <= 2,
    `底部留白异常（期望 20px 内边距，实际 ${gap.toFixed(1)}px），说明总高度或条目测量与真实布局不一致`,
  );

  // 5. 跟随：停在底部时追加内容，滚动位置应一直保持在底部。
  for (let round = 0; round < 3; round += 1) {
    await evaluate("window.__messageListFixture.grow()");
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const followed = await wait(
    (state) => state.viewport.scrollHeight - state.viewport.scrollTop - state.viewport.clientHeight <= 4,
    "追加内容后保持在底部",
  );
  const grew = await evaluate("window.__messageListFixture.grown()");
  assert(grew === 3, `追加内容未生效：grown=${grew}`);
  assert(
    followed.anchors.includes(`assistant-${turns - 1}`),
    "追加内容后最后一条未挂载",
  );
  assert(followed.itemCount < 40, `追加内容后挂载条目过多：${followed.itemCount}`);

  // 6. 用户往上滚一点：必须真的停在上面（本次修复的核心回归）。
  //    成因：跟随循环每帧把 scrollTop 贴回底部（96px 内是瞬时贴底），旧的
  //    「距底 ≤16px 就不算用户滚动」判据在跟随期间永远成立，于是用户滚出去的位移
  //    被当成虚拟列表的被动补偿立刻拉回——表现就是「往上滚一点就弹回底部」。
  const nudgeGap = await gesture("up", 24);
  assert(nudgeGap >= 12, `往上滚 24px 后当场只剩 ${nudgeGap}px，位移被立刻拉回`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const nudgedGap = await bottomGap();
  assert(nudgedGap >= 12, `往上滚 24px 后 400ms 内被打回底部：距底 ${nudgedGap}px`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const heldGap = await bottomGap();
  assert(
    Math.abs(heldGap - nudgedGap) <= 3,
    `离开底部后位置不稳定（跟随循环仍在抢滚动）：${nudgedGap}px → ${heldGap}px`,
  );

  // 7. 离开底部期间内容继续增长：阅读位置保持，跟随保持关闭。
  for (let round = 0; round < 3; round += 1) {
    await evaluate("window.__messageListFixture.grow()");
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const grownGap = await bottomGap();
  assert(
    grownGap >= heldGap - 4,
    `内容增长把阅读位置拉走了：距底 ${heldGap}px → ${grownGap}px`,
  );

  // 8. 往下滚回底部：跟随自动恢复，之后内容增长继续贴底。
  await gesture("down", 600);
  await wait(
    (state) => state.viewport.scrollHeight - state.viewport.scrollTop - state.viewport.clientHeight <= 4,
    "往下滚后恢复贴底",
  );
  for (let round = 0; round < 2; round += 1) {
    await evaluate("window.__messageListFixture.grow()");
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const refollowed = await wait(
    (state) => state.viewport.scrollHeight - state.viewport.scrollTop - state.viewport.clientHeight <= 4,
    "恢复跟随后内容增长仍贴底",
  );
  assert(refollowed.itemCount < 40, `恢复跟随后挂载条目过多：${refollowed.itemCount}`);

  // 9. 对照：没有手势的程序化位移仍要被跟随吸收。虚拟列表的测量补偿与浏览器锚定
  //    也会这样改 scrollTop，把它当成「用户离开」就等于把流式期间的抖动放回来。
  await evaluate(`(() => { const box = document.querySelector('.conversation'); box.scrollTop -= 24; })()`);
  await wait(
    (state) => state.viewport.scrollHeight - state.viewport.scrollTop - state.viewport.clientHeight <= 4,
    "被动位移被跟随吸收",
  );

  // 10. 跳转到最早的一轮：条目自动挂载并贴到视口顶部。
  //     先往上滚离开底部（跟随关闭、锚点指向旧位置），再跳转，覆盖「跳转被旧锚点拉回」的场景；
  //     手势离开是前提——没有手势的程序化位移会被跟随当成被动补偿吸收掉（见第 9 步）。
  //     注意断言的是**收敛后**的落点：跳进未测量区域时 virtua 会按跳转前的旧内部偏移
  //     做一次测量补偿（把落点推走一个估算误差，下一轮校正才落准），首次可见的位置
  //     可能带一次短暂回弹，不能当契约。
  await gesture("up", 2_400);
  await wait((state) => state.viewport.scrollTop < state.viewport.scrollHeight - state.viewport.clientHeight - 100, "离开底部");
  await evaluate("window.__messageListFixture.scrollToAnchor('turn-user-0')");
  const jumped = await wait((state) => {
    if (!state.anchors.includes("assistant-0")) return false;
    const first = state.rects[0];
    return Boolean(first) && first!.top >= state.viewport.top - 1 && first!.top <= state.viewport.top + 40;
  }, "跳转到首轮并收敛");
  const firstItem = jumped.rects[0]!;
  assert(
    firstItem.top >= jumped.viewport.top - 1 && firstItem.top <= jumped.viewport.top + 40,
    `跳转后首个条目未落在视口顶部：${JSON.stringify({ itemTop: firstItem.top, viewportTop: jumped.viewport.top })}`,
  );
  assert(jumped.itemCount < 40, `跳转后挂载条目过多：${jumped.itemCount}`);

  // 11. 跳转后位置保持：内容继续测量时不得被拉回旧位置。
  await new Promise((resolve) => setTimeout(resolve, 400));
  const held = await read();
  assert(
    held.anchors.includes("assistant-0"),
    `跳转后位置被内容测量拉走：当前锚点=${held.anchors.join(",")}`,
  );

  // 12. 锚点查询：当前阅读位置能定位到具体轮次（轮次导航依赖它）。
  const anchor = await evaluate("window.__messageListFixture.anchorAt(160)");
  assert(
    typeof anchor === "string" && anchor.startsWith("turn-user-"),
    `anchorAt 未返回当前轮次：${String(anchor)}`,
  );
}
