/**
 * 文件：js/interaction.js
 *
 * 这个文件负责鼠标和键盘，不创建缓冲，也不调用 gl.drawArrays。
 * 它只改 main.js 传进来的 state。下一帧绘制时读这些数字，画面才会动。
 *
 * 二维垫片：
 *   左键拖动 → state.panX / panY，也就是平移
 *   滚轮     → state.zoom，并且让光标底下的点保持不动
 * 四面体预览：
 *   左键拖动 → state.yaw / pitch，转模型
 *   滚轮     → state.distance，拉远或拉近相机
 * 键盘：
 *   1 / 2 / 3 → 点、线框、实体
 *   空格      → 暂停或继续逐点生长
 */

/**
 * 把鼠标在画布上的位置换成裁剪坐标。
 * 画布左边缘是 x = -1，右边缘是 x = 1；上边缘是 y = 1，下边缘是 y = -1。
 * 屏幕的 y 向下增大，裁剪空间的 y 向上增大，所以要用 1 - y。
 */
function clipFromEvent(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { rect, x: x * 2 - 1, y: 1 - y * 2 };
}

/**
 * 把滚轮的 deltaY 统一成像素。
 * deltaMode 为 0 时浏览器已经给的是像素；
 * 为 1 时单位是“行”，大约 16 像素；为 2 时单位是整页。
 */
function wheelPixels(event, rect) {
  let dy = event.deltaY;
  if (event.deltaMode === 1) dy *= 16;
  if (event.deltaMode === 2) dy *= rect.height;
  return dy;
}

/**
 * 焦点在下拉框、按钮、勾选框上时，不要抢走 1/2/3 和空格。
 * 否则老师在面板上按空格，会同时勾选控件又暂停动画。
 * 滑条不是这些类型，所以拖完滑条之后按数字键仍然能换模式。
 */
function ignoresShortcut(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  if (tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return true;
  if (tag === "INPUT") {
    const type = (target.type || "").toLowerCase();
    return type === "text" || type === "number" || type === "checkbox" || type === "radio";
  }
  return false;
}

export function bindInteraction(canvas, state, hooks) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  // 只认左键。按下时记下起点，并把焦点给画布，后面的键盘事件才会落到这里。
  function onPointerDown(event) {
    if (event.button !== 0) return;
    dragging = true;
    state.dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.focus();
  }

  /**
   * 移动量是“这一帧鼠标比上一帧多走了多少像素”，不是距离按下点的总位移。
   * 监听在 window 上，所以鼠标拖出画布也不会断。
   */
  function onPointerMove(event) {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (dx === 0 && dy === 0) return;

    if (state.algorithm === "tetra") {
      // 水平移动改绕 y 轴的角度，垂直移动改绕 x 轴的角度。俯仰角夹住，避免翻过去。
      state.yaw += dx * 0.45;
      state.pitch += dy * 0.35;
      state.pitch = Math.max(-85, Math.min(85, state.pitch));
      return;
    }

    // 像素位移换成裁剪空间位移：画布宽度对应 2 个单位。
    // y 要取反，因为屏幕向下拖，图形应该跟着向下，而裁剪空间的 y 向上为正。
    const rect = canvas.getBoundingClientRect();
    state.panX += (dx / rect.width) * 2;
    state.panY -= (dy / rect.height) * 2;
  }

  function endDrag() {
    dragging = false;
    state.dragging = false;
  }

  /**
   * 滚轮。preventDefault 是为了不让整页跟着滚动。
   * 必须用 { passive: false } 注册，否则浏览器会忽略 preventDefault。
   *
   * dy > 0 是向下滚，factor < 1，二维就是缩小。
   * 二维还要改 pan，让光标底下的那个世界点保持不动，看起来才是“朝光标放大”。
   * 推导：clip = zoom * world + pan，放大后仍要 clip 不变，
   * 所以 pan' = clip * (1 - zoom'/zoom) + pan * (zoom'/zoom)。
   */
  function onWheel(event) {
    event.preventDefault();
    const { rect, x, y } = clipFromEvent(event, canvas);
    const dy = wheelPixels(event, rect);
    const factor = Math.exp(-dy * 0.0012);

    if (state.algorithm === "tetra") {
      state.distance = Math.min(12, Math.max(1.6, state.distance / factor));
      return;
    }

    const nextZoom = Math.min(28, Math.max(0.25, state.zoom * factor));
    const scale = nextZoom / state.zoom;
    state.panX = x * (1 - scale) + state.panX * scale;
    state.panY = y * (1 - scale) + state.panY * scale;
    state.zoom = nextZoom;
  }

  // 1 / 2 / 3 换图元，空格暂停或继续逐点生长。具体怎么切在 main.js。
  function onKeyDown(event) {
    if (ignoresShortcut(event.target)) return;
    if (event.code === "Digit1" || event.key === "1") {
      event.preventDefault();
      hooks.setPrimitive("points");
    } else if (event.code === "Digit2" || event.key === "2") {
      event.preventDefault();
      hooks.setPrimitive("lines");
    } else if (event.code === "Digit3" || event.key === "3") {
      event.preventDefault();
      hooks.setPrimitive("triangles");
    } else if (event.code === "Space") {
      event.preventDefault();
      hooks.toggleGrowth();
    }
  }

  canvas.addEventListener("mousedown", onPointerDown);
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("mouseup", endDrag);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);

  return function unbind() {
    canvas.removeEventListener("mousedown", onPointerDown);
    window.removeEventListener("mousemove", onPointerMove);
    window.removeEventListener("mouseup", endDrag);
    canvas.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown);
  };
}
