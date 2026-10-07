/**
 * 文件：js/main.js
 *
 * 这个文件是整页的总控。页面打开后从这里开始跑。
 * 它自己不写混沌游戏公式，也不监听滑条；它负责把另外三个文件接起来：
 *   geometry.js 算出顶点 → 这里用 gl.bufferData 送进显卡
 *   interaction.js / ui.js 改 state → 这里每一帧读 state 并重画
 *
 * 一帧里实际发生的事：
 *   1. 若正在逐点生长，就把“已经画出的点数”加大一点
 *   2. 用 MV.js 拼好平移、缩放或相机矩阵
 *   3. gl.drawArrays 按当前模式画点、线或三角形
 *
 * Common/ 里的脚本是普通 script，函数挂在全局上：
 *   WebGLUtils.setupWebGL、initShaders、vec3、mult、translate、rotate、
 *   scale、lookAt、perspective、flatten。
 * 本文件是 type="module"，可以直接调用这些全局名字。
 */

import { NGON_PRESETS, buildMesh, paint } from "./geometry.js";
import { bindInteraction } from "./interaction.js";
import { PALETTES, bindUI } from "./ui.js";

const canvas = document.getElementById("gl-canvas");
const hint = document.getElementById("hint");

/**
 * 整个程序只有这一份状态，面板、鼠标、绘制循环都读写它。
 * visible 是混沌游戏“已经画出来的点数”，从 0 涨到 vertexCount，这就是逐点生长。
 * pan / zoom 是二维视图；yaw / pitch / distance 是四面体的转角和相机距离。
 */
const state = {
  algorithm: "chaos",
  primitive: "points",
  vertexCount: 20000,
  depth: 5,
  pointSize: 2.5,
  palette: "classic",
  sides: 3,
  ratio: 0.5,
  restriction: "none",
  growing: true,
  visible: 0,
  panX: 0,
  panY: 0,
  zoom: 1,
  yaw: 24,
  pitch: 16,
  distance: 3.4,
  dragging: false,
};

// 地址栏参数只为了截图和验收时直接打开某一种画面，正常打开页面不会走到这里。
const params = new URLSearchParams(location.search);
if (params.get("algo") === "recursive" || params.get("algo") === "tetra" || params.get("algo") === "chaos") {
  state.algorithm = params.get("algo");
}
if (params.has("mode") && ["points", "lines", "triangles"].includes(params.get("mode"))) {
  state.primitive = params.get("mode");
}
if (params.has("depth")) state.depth = clamp(Number(params.get("depth")), 0, 6);
if (params.has("count")) state.vertexCount = clamp(Number(params.get("count")), 5000, 60000);
if (params.has("sides")) state.sides = clamp(Number(params.get("sides")), 3, 6);
if (params.get("grow") === "0") {
  state.growing = false;
  state.visible = state.vertexCount;
}
if (state.algorithm === "chaos" && state.primitive !== "points") {
  state.algorithm = "recursive";
}
if (params.has("sides") && NGON_PRESETS[state.sides]) {
  state.ratio = NGON_PRESETS[state.sides].ratio;
  state.restriction = NGON_PRESETS[state.sides].restriction;
}

// 教材的 setupWebGL 原本只找 WebGL 1。webgl-utils.js 里已把 "webgl2" 放在名单最前。
// createVertexArray 是 WebGL 2 才有的，用来确认拿到的确实是 2.0 上下文。
const gl = WebGLUtils.setupWebGL(canvas, { antialias: true, alpha: false });
if (!gl || typeof gl.createVertexArray !== "function") {
  hint.textContent = "当前浏览器没有可用的 WebGL 2.0 上下文。";
  throw new Error("WebGL 2 required");
}

// initShaders 按 id 读取 index.html 里那两段着色器文本，编译并链接成一个程序。
const program = initShaders(gl, "vertex-shader", "fragment-shader");
if (!program || program === -1) {
  throw new Error("shader init failed");
}
gl.useProgram(program);

// uniform 是整幅图共用的量（矩阵、点大小）；attribute 是每个顶点一份（坐标、颜色、法线）。
const loc = {
  mvp: gl.getUniformLocation(program, "uMVP"),
  model: gl.getUniformLocation(program, "uModel"),
  pointSize: gl.getUniformLocation(program, "uPointSize"),
  lighting: gl.getUniformLocation(program, "uLighting"),
  round: gl.getUniformLocation(program, "uRoundPoints"),
  position: gl.getAttribLocation(program, "aPosition"),
  color: gl.getAttribLocation(program, "aColor"),
  normal: gl.getAttribLocation(program, "aNormal"),
};

/**
 * VAO 记住“哪个缓冲对哪个 attribute、每个顶点几个 float”。
 * 后面每帧只要 bindVertexArray，就不用重新交代布局。
 * vertexAttribPointer 的 3 表示 vec3；stride 为 0 表示数据紧挨着排，没有间隔。
 */
const vao = gl.createVertexArray();
const positionBuffer = gl.createBuffer();
const colorBuffer = gl.createBuffer();
const normalBuffer = gl.createBuffer();

gl.bindVertexArray(vao);
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.enableVertexAttribArray(loc.position);
gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 0, 0);
gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
gl.enableVertexAttribArray(loc.color);
gl.vertexAttribPointer(loc.color, 3, gl.FLOAT, false, 0, 0);
gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
gl.enableVertexAttribArray(loc.normal);
gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 0, 0);

let mesh = null;
let meshKey = "";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function paletteColors() {
  return PALETTES[state.palette].colors;
}

/**
 * 几何没变就不要重算。点和实体共用同一份三角形顶点，所以它们的 topology 都记成 fill；
 * 线框每个三角形要 6 个顶点，必须分开缓存。
 */
function geometryKey() {
  const topology = state.algorithm === "chaos"
    ? "points"
    : (state.primitive === "lines" ? "lines" : "fill");
  return [
    state.algorithm,
    topology,
    state.vertexCount,
    state.depth,
    state.sides,
    state.ratio.toFixed(4),
    state.restriction,
  ].join("|");
}

/**
 * gl.bufferData 把 CPU 上的类型化数组整块拷到当前绑定的 VBO。
 * STATIC_DRAW 告诉驱动：数据上传后很少改，适合反复绘制。
 */
function uploadArray(buffer, data) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
}

function uploadMesh(next) {
  mesh = next;
  uploadArray(positionBuffer, mesh.positions);
  uploadArray(normalBuffer, mesh.normals);
  uploadColors();
}

function uploadColors() {
  if (!mesh) return;
  uploadArray(colorBuffer, paint(mesh.colorIndex, paletteColors()));
}

/**
 * 参数变了才调用 buildMesh。混沌游戏如果正在生长，新的一批点从 0 重新长；
 * 如果已经暂停，就直接画出全部，避免一改滑条画面就空了。
 */
function rebuildGeometry() {
  const key = geometryKey();
  if (key === meshKey && mesh) return;
  meshKey = key;
  uploadMesh(buildMesh({
    algorithm: state.algorithm,
    primitive: state.primitive === "lines" ? "lines" : "triangles",
    vertexCount: state.vertexCount,
    depth: state.depth,
    sides: state.sides,
    ratio: state.ratio,
    restriction: state.restriction,
  }));
  if (state.algorithm === "chaos") {
    state.visible = state.growing ? 0 : state.vertexCount;
  }
}

/**
 * 1 / 2 / 3 和面板单选框都走这里。
 * 混沌游戏只有点。若在点云上按 2 或 3，就改用递归细分，
 * 因为随机点列没有“边”和“面”可以连。
 */
function setPrimitive(name) {
  state.primitive = name;
  if (name !== "points" && state.algorithm === "chaos") {
    state.algorithm = "recursive";
  }
  rebuildGeometry();
  ui.sync();
  updateHint();
}

// 勾选框：正在生长时取消勾选就是暂停；已经长完再勾上，就从 0 再播一次。
function setGrowing(next) {
  if (next && state.visible >= state.vertexCount - 0.5) state.visible = 0;
  state.growing = next;
  ui.sync();
}

/**
 * 空格。生长途中按下：暂停。
 * 暂停后再按：从当前点数继续。
 * 已经长满后再按：visible 归零，从头再长。
 */
function toggleGrowth() {
  const finished = state.visible >= state.vertexCount - 0.5;
  if (state.growing && !finished) {
    state.growing = false;
  } else {
    if (finished) state.visible = 0;
    state.growing = true;
  }
  ui.sync();
}

function resetView() {
  state.panX = 0;
  state.panY = 0;
  state.zoom = 1;
  state.yaw = 24;
  state.pitch = 16;
  state.distance = 3.4;
}

function applySidesPreset() {
  const preset = NGON_PRESETS[state.sides];
  state.ratio = preset.ratio;
  state.restriction = preset.restriction;
  meshKey = "";
  rebuildGeometry();
}

const ui = bindUI(state, {
  onGeometry() {
    meshKey = "";
    rebuildGeometry();
  },
  onPalette() {
    uploadColors();
  },
  onSides() {
    applySidesPreset();
  },
  onResetView: resetView,
  setPrimitive,
  setGrowing,
});

bindInteraction(canvas, state, { setPrimitive, toggleGrowth });

function updateHint() {
  if (state.algorithm === "tetra") {
    hint.textContent = "左键拖动旋转 · 滚轮拉近或拉远 · 1 / 2 / 3 切换点、线框、实体";
  } else {
    hint.textContent = "左键拖动平移 · 滚轮缩放 · 1 / 2 / 3 切换模式 · 空格暂停或继续逐点生长";
  }
}

/**
 * 画布的 CSS 尺寸和绘图缓冲可以不一样。
 * 高分屏上把缓冲放大到设备像素，图才不会糊。viewport 告诉 WebGL 画到整块缓冲上。
 */
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
}

/**
 * 模型矩阵。MV.js 的矩阵乘在列向量上，mult(A, B) 表示先做 B 再做 A。
 *
 * 二维：先 scale 再 translate。x 方向除以宽高比，否则宽画布上的三角形会被拉扁。
 * 三维：先绕 x 轴俯仰，再绕 y 轴转向。相机不放进这个矩阵，单独在 mvpMatrix 里处理。
 */
function modelMatrix() {
  if (state.algorithm === "tetra") {
    return mult(rotate(state.yaw, vec3(0, 1, 0)), rotate(state.pitch, vec3(1, 0, 0)));
  }
  const aspect = canvas.width / Math.max(1, canvas.height);
  return mult(translate(state.panX, state.panY, 0), scale(state.zoom / aspect, state.zoom, 1));
}

/**
 * 最终拿去乘顶点的矩阵。
 * 二维垫片的坐标本来就在 [-1, 1] 里，模型矩阵就是裁剪矩阵，不需要投影。
 * 三维是 投影 × 视图 × 模型：
 *   lookAt 把相机放在 (0, 0, distance)，看向原点，头顶朝 +y
 *   perspective 的 40 是垂直视场角，单位是度；近平面 0.1，远平面 30
 */
function mvpMatrix(model) {
  if (state.algorithm !== "tetra") return model;
  const eye = vec3(0, 0, state.distance);
  const view = lookAt(eye, vec3(0, 0, 0), vec3(0, 1, 0));
  const proj = perspective(40, canvas.width / Math.max(1, canvas.height), 0.1, 30);
  return mult(proj, mult(view, model));
}

function drawMode() {
  if (state.primitive === "lines") return gl.LINES;
  if (state.primitive === "triangles") return gl.TRIANGLES;
  return gl.POINTS;
}

/**
 * drawArrays 的第三个参数是“从缓冲开头画几个顶点”。
 * 混沌游戏不改缓冲，只把这个数量从 0 增加到顶点总数，看起来就是点在慢慢长出来。
 * 递归和四面体一次画完。
 */
function drawCount() {
  if (state.algorithm === "chaos") return Math.max(0, Math.floor(state.visible));
  return mesh ? mesh.count : 0;
}

function statusText() {
  const names = { chaos: "混沌游戏", recursive: "递归细分", tetra: "四面体垫片" };
  const modes = { points: "点", lines: "线框", triangles: "实体" };
  if (state.algorithm === "chaos") {
    const shown = Math.floor(state.visible);
    const finished = shown >= state.vertexCount;
    const motion = finished ? "已长成" : (state.growing ? "生长中" : "已暂停");
    return `${names.chaos} · ${state.sides} 边形 · ${motion} · ${shown} / ${state.vertexCount} 点`;
  }
  const triangles = mesh ? (state.primitive === "lines" ? mesh.count / 6 : mesh.count / 3) : 0;
  const amount = state.primitive === "points" && mesh
    ? `${mesh.count} 个顶点`
    : `${triangles} 个三角形`;
  return `${names[state.algorithm]} · ${modes[state.primitive]} · 深度 ${state.depth} · ${amount}`;
}

let lastTime = performance.now();

/**
 * 浏览器每次准备好下一帧就调用这里。requestAnimFrame 来自 webgl-utils.js。
 * dt 是距离上一帧的秒数，并且不超过 0.05，避免切走标签页再回来时一下子长出太多点。
 */
function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  // 约 8 秒从 0 长到设定点数：每秒增加 vertexCount / 8 个点。
  if (state.algorithm === "chaos" && state.growing) {
    const rate = state.vertexCount / 8;
    state.visible = Math.min(state.vertexCount, state.visible + rate * dt);
  }
  // 没在拖鼠标时四面体自己转。拖动时 interaction.js 会把 dragging 设为 true。
  if (state.algorithm === "tetra" && !state.dragging) {
    state.yaw += dt * 16;
  }

  resize();
  rebuildGeometry();

  const background = PALETTES[state.palette].background;
  gl.clearColor(background[0], background[1], background[2], background[3]);
  // 只有三维实体需要深度测试，否则前后面会叠乱。二维所有点的 z 都是 0，开了反而可能互相挡住。
  const solid3d = state.algorithm === "tetra" && state.primitive === "triangles";
  if (solid3d) gl.enable(gl.DEPTH_TEST);
  else gl.disable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const model = modelMatrix();
  // flatten 把 MV.js 的行优先矩阵转成 WebGL 要的列优先，所以第二个参数 transpose 填 false。
  gl.uniformMatrix4fv(loc.mvp, false, flatten(mvpMatrix(model)));
  gl.uniformMatrix4fv(loc.model, false, flatten(model));
  const dpr = canvas.width / Math.max(1, canvas.clientWidth);
  const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  gl.uniform1f(loc.pointSize, Math.min(pointRange[1], state.pointSize * dpr));
  gl.uniform1f(loc.lighting, solid3d ? 1 : 0);
  gl.uniform1f(loc.round, state.primitive === "points" ? 1 : 0);

  gl.bindVertexArray(vao);
  gl.drawArrays(drawMode(), 0, drawCount());
  ui.setStatus(statusText());
  window.requestAnimFrame(frame);
}

updateHint();
rebuildGeometry();
window.requestAnimFrame(frame);
window.addEventListener("resize", resize);
