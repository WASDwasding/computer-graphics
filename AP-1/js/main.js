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
  algorithm: "chaos", // "chaos" 混沌游戏，"recursive" 递归细分，"tetra" 四面体
  primitive: "points", // "points" | "lines" | "triangles"，对应 gl.POINTS / LINES / TRIANGLES
  vertexCount: 20000, // 混沌游戏要生成的总点数。滑条最小值是 5000
  depth: 5, // 递归深度。0 是不挖洞的整个三角形，6 是最深
  pointSize: 2.5, // 传给着色器的 gl_PointSize，单位是像素
  palette: "classic", // 三套配色之一，见 ui.js 的 PALETTES
  sides: 3, // 混沌游戏的边数。3 才是作业要求的三角形垫片
  ratio: 0.5, // 朝顶点走的比例。0.5 时公式就是 (p+v)/2
  restriction: "none", // 选点限制：none / no-repeat / no-neighbor
  growing: true, // 空格或勾选框会改它。true 时每帧增加 visible
  visible: 0, // 混沌游戏当前画到第几个点。从 0 涨到 vertexCount
  panX: 0, // 二维平移，单位是裁剪坐标
  panY: 0,
  zoom: 1, // 二维缩放倍数
  yaw: 24, // 四面体绕 y 轴的角度，单位是度
  pitch: 16, // 四面体绕 x 轴的角度
  distance: 3.4, // 相机离原点的距离
  dragging: false, // 正在拖鼠标时四面体不自动转
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
  // createVertexArray 只有 WebGL 2 有。如果这里失败，说明拿到的是 WebGL 1 或根本没拿到上下文。
  hint.textContent = "当前浏览器没有可用的 WebGL 2.0 上下文。";
  throw new Error("WebGL 2 required");
}

// initShaders 按 id 读取 index.html 里那两段着色器文本，编译并链接成一个程序。
const program = initShaders(gl, "vertex-shader", "fragment-shader");
if (!program || program === -1) {
  throw new Error("shader init failed"); // initShaders 失败时返回 -1，并已经 alert 过日志
}
gl.useProgram(program); // 之后的绘制都用这个着色器程序，直到换别的程序

// uniform 是整幅图共用的量（矩阵、点大小）；attribute 是每个顶点一份（坐标、颜色、法线）。
const loc = {
  mvp: gl.getUniformLocation(program, "uMVP"), // 顶点着色器里的矩阵变量在显卡里的编号
  model: gl.getUniformLocation(program, "uModel"),
  pointSize: gl.getUniformLocation(program, "uPointSize"),
  lighting: gl.getUniformLocation(program, "uLighting"),
  round: gl.getUniformLocation(program, "uRoundPoints"),
  position: gl.getAttribLocation(program, "aPosition"), // 每个顶点的坐标从哪条 attribute 读
  color: gl.getAttribLocation(program, "aColor"),
  normal: gl.getAttribLocation(program, "aNormal"),
};

/**
 * VAO 记住“哪个缓冲对哪个 attribute、每个顶点几个 float”。
 * 后面每帧只要 bindVertexArray，就不用重新交代布局。
 * vertexAttribPointer 的 3 表示 vec3；stride 为 0 表示数据紧挨着排，没有间隔。
 */
const vao = gl.createVertexArray(); // 顶点数组对象，把下面的缓冲和 attribute 绑定关系存起来
const positionBuffer = gl.createBuffer(); // 存 xyz 的 VBO
const colorBuffer = gl.createBuffer(); // 存 rgb 的 VBO
const normalBuffer = gl.createBuffer(); // 存法线的 VBO

gl.bindVertexArray(vao);
// 先绑定位置缓冲，再告诉 attribute：每个顶点读 3 个 float，不归一化，紧密排列，从偏移 0 开始。
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.enableVertexAttribArray(loc.position); // 不 enable 的话着色器读到的是默认值 0
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
  // 点和实体的顶点序列一样，缓存键都写成 fill；线框是另一种展开，必须分开。
  const topology = state.algorithm === "chaos"
    ? "points"
    : (state.primitive === "lines" ? "lines" : "fill");
  return [
    state.algorithm, // 换算法一定重算
    topology,
    state.vertexCount, // 混沌游戏点数变了要重算；细分时这个数不参与公式，但写进键里无害
    state.depth,
    state.sides,
    state.ratio.toFixed(4), // 步长保留 4 位，避免 0.5000001 这种浮点抖动反复重算
    state.restriction,
  ].join("|");
}

/**
 * gl.bufferData 把 CPU 上的类型化数组整块拷到当前绑定的 VBO。
 * STATIC_DRAW 告诉驱动：数据上传后很少改，适合反复绘制。
 */
function uploadArray(buffer, data) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer); // 接下来的 bufferData 写进这个 VBO
  // data 是 Float32Array。这一行就是“CPU 数组 → 显卡缓冲”。STATIC_DRAW 表示上传后主要用来反复画。
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
  if (key === meshKey && mesh) return; // 算法、点数、深度都没变，沿用上一份缓冲
  meshKey = key;
  uploadMesh(buildMesh({
    algorithm: state.algorithm,
    // 点和实体顶点布局相同，都让 geometry 按三角形展开。线框才要 6 顶点的布局。
    primitive: state.primitive === "lines" ? "lines" : "triangles",
    vertexCount: state.vertexCount,
    depth: state.depth,
    sides: state.sides,
    ratio: state.ratio,
    restriction: state.restriction,
  }));
  if (state.algorithm === "chaos") {
    // 正在生长就从 0 重新长；暂停时直接显示全部，避免一动滑条画面变空。
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
  // 混沌游戏的数据只是一串没有先后连接关系的点。要画线或面，必须改用递归细分的三角形。
  if (name !== "points" && state.algorithm === "chaos") {
    state.algorithm = "recursive";
  }
  rebuildGeometry();
  ui.sync(); // 把面板上的单选框和算法下拉框改成和 state 一致
  updateHint();
}

// 勾选框：正在生长时取消勾选就是暂停；已经长完再勾上，就从 0 再播一次。
function setGrowing(next) {
  // 已经长满再打开生长，就把可见点数清零，否则勾上之后画面不会有变化。
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
  const finished = state.visible >= state.vertexCount - 0.5; // 用 0.5 是因为 visible 按时间累加，可能是 19999.7
  if (state.growing && !finished) {
    state.growing = false; // 长到一半：暂停，visible 留在当前值
  } else {
    if (finished) state.visible = 0; // 已经长完：从头再播
    state.growing = true; // 暂停中：从当前点数继续
  }
  ui.sync();
}

function resetView() {
  state.panX = 0;
  state.panY = 0;
  state.zoom = 1; // 回到初始缩放，图形重新居中
  state.yaw = 24;
  state.pitch = 16;
  state.distance = 3.4; // 四面体相机回到初始距离
}

function applySidesPreset() {
  const preset = NGON_PRESETS[state.sides];
  state.ratio = preset.ratio; // 例如五边形换成约 0.618
  state.restriction = preset.restriction; // 例如四边形改成不能连续选同一个顶点
  meshKey = ""; // 强制下一帧重算，即使数字碰巧和上次一样
  rebuildGeometry();
}

const ui = bindUI(state, {
  onGeometry() {
    meshKey = ""; // 清空缓存键，下一行一定会重算
    rebuildGeometry();
  },
  onPalette() {
    uploadColors(); // 几何不动，只把 colorIndex 重新映射成新的 RGB
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
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // 视网膜屏 1 个 CSS 像素对应 2 个物理像素，上限 2 避免缓冲过大
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    // 改 canvas.width 会清空绘图缓冲，所以只在尺寸真的变了时才写。
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, canvas.width, canvas.height); // 把裁剪空间的 [-1,1] 映射到整块缓冲
}

/**
 * 模型矩阵。MV.js 的矩阵乘在列向量上，mult(A, B) 表示先做 B 再做 A。
 *
 * 二维：先 scale 再 translate。x 方向除以宽高比，否则宽画布上的三角形会被拉扁。
 * 三维：先绕 x 轴俯仰，再绕 y 轴转向。相机不放进这个矩阵，单独在 mvpMatrix 里处理。
 */
function modelMatrix() {
  if (state.algorithm === "tetra") {
    // mult(绕 y, 绕 x)：列向量先乘右边的矩阵，所以先俯仰、再左右转。
    return mult(rotate(state.yaw, vec3(0, 1, 0)), rotate(state.pitch, vec3(1, 0, 0)));
  }
  const aspect = canvas.width / Math.max(1, canvas.height); // 宽高比。高为 0 时用 1，避免除零
  // x 缩放除以 aspect：宽画布上水平方向少放大一点，三角形才不会被拉扁。
  // mult(平移, 缩放) 表示先缩放、再平移。
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
  if (state.algorithm !== "tetra") return model; // 二维坐标已经在 [-1,1]，不再做投影
  const eye = vec3(0, 0, state.distance); // 相机在 +z 轴上
  const view = lookAt(eye, vec3(0, 0, 0), vec3(0, 1, 0)); // 看原点，上方向是 +y
  // 40 是垂直张角的度数；0.1 和 30 是近、远裁剪面，太近或太远的东西会被切掉。
  const proj = perspective(40, canvas.width / Math.max(1, canvas.height), 0.1, 30);
  // 列向量先模型、再视图、再投影，所以写出来是 proj * view * model。
  return mult(proj, mult(view, model));
}

function drawMode() {
  if (state.primitive === "lines") return gl.LINES; // 每两个顶点一条线段
  if (state.primitive === "triangles") return gl.TRIANGLES; // 每三个顶点一个实心三角形
  return gl.POINTS; // 每个顶点一个点
}

/**
 * drawArrays 的第三个参数是“从缓冲开头画几个顶点”。
 * 混沌游戏不改缓冲，只把这个数量从 0 增加到顶点总数，看起来就是点在慢慢长出来。
 * 递归和四面体一次画完。
 */
function drawCount() {
  if (state.algorithm === "chaos") return Math.max(0, Math.floor(state.visible)); // 只画缓冲开头的这么多个点
  return mesh ? mesh.count : 0; // 递归和四面体一次把算好的顶点全部画完
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
  // 线框每个三角形占 6 个顶点，实体和点模式每个三角形占 3 个顶点。除完就是三角形个数。
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
  // now 是毫秒。转成秒，并限制单帧最多 0.05 秒，避免切回页面时一次加上好几秒的点。
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (state.algorithm === "chaos" && state.growing) {
    const rate = state.vertexCount / 8; // 8 秒长完：20000 个点大约每秒 2500 个
    // 不超过总数。缓冲里点是按迭代顺序排的，所以画前 visible 个就是“先长出来的那些点”。
    state.visible = Math.min(state.vertexCount, state.visible + rate * dt);
  }
  if (state.algorithm === "tetra" && !state.dragging) {
    state.yaw += dt * 16; // 每秒转 16 度
  }

  resize();
  rebuildGeometry();

  const background = PALETTES[state.palette].background;
  // clearColor 的四个数是 r,g,b,a，范围 0 到 1，不是 0 到 255。
  gl.clearColor(background[0], background[1], background[2], background[3]);
  const solid3d = state.algorithm === "tetra" && state.primitive === "triangles";
  if (solid3d) gl.enable(gl.DEPTH_TEST); // 比较深度，离相机远的面不要画在近的面上面
  else gl.disable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); // 清颜色，也清上一帧留下的深度

  const model = modelMatrix();
  // 第二个参数 false：不要让 WebGL 再转置一次，因为 flatten 已经转成列优先了。
  gl.uniformMatrix4fv(loc.mvp, false, flatten(mvpMatrix(model)));
  gl.uniformMatrix4fv(loc.model, false, flatten(model)); // 法线只用模型旋转，不乘投影
  const dpr = canvas.width / Math.max(1, canvas.clientWidth); // 缓冲像素 / CSS 像素
  const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE); // 驱动允许的最小、最大点尺寸
  gl.uniform1f(loc.pointSize, Math.min(pointRange[1], state.pointSize * dpr)); // 不超过驱动上限
  gl.uniform1f(loc.lighting, solid3d ? 1 : 0); // 着色器里用 > 0.5 判断开关
  gl.uniform1f(loc.round, state.primitive === "points" ? 1 : 0); // 只有点需要裁成圆形

  gl.bindVertexArray(vao); // 恢复位置、颜色、法线三条缓冲的绑定
  // 从第 0 个顶点开始，画 drawCount() 个。图元类型由 1/2/3 决定。
  gl.drawArrays(drawMode(), 0, drawCount());
  ui.setStatus(statusText());
  window.requestAnimFrame(frame); // 登记下一帧再进来，形成循环
}

updateHint();
rebuildGeometry(); // 第一帧之前先把顶点送进显卡，避免第一帧无数据
window.requestAnimFrame(frame); // 启动循环
window.addEventListener("resize", resize);
