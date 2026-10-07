/**
 * 键鼠交互。只改传入的 state，不碰 WebGL。
 * 二维：左键拖动平移，滚轮缩放（缩放中心是光标）。
 * 四面体预览：左键拖动相当于转模型，滚轮改观察距离。
 */

function clipFromEvent(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { rect, x: x * 2 - 1, y: 1 - y * 2 };
}

function wheelPixels(event, rect) {
  let dy = event.deltaY;
  if (event.deltaMode === 1) dy *= 16;
  if (event.deltaMode === 2) dy *= rect.height;
  return dy;
}

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

  function onPointerDown(event) {
    if (event.button !== 0) return;
    dragging = true;
    state.dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.focus();
  }

  function onPointerMove(event) {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (dx === 0 && dy === 0) return;

    if (state.algorithm === "tetra") {
      state.yaw += dx * 0.45;
      state.pitch += dy * 0.35;
      state.pitch = Math.max(-85, Math.min(85, state.pitch));
      return;
    }

    const rect = canvas.getBoundingClientRect();
    state.panX += (dx / rect.width) * 2;
    state.panY -= (dy / rect.height) * 2;
  }

  function endDrag() {
    dragging = false;
    state.dragging = false;
  }

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
