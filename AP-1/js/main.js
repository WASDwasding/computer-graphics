/**
 * AP1 渲染入口。
 * 数据路径：geometry.js 生成 Float32Array → bufferData 写入 VBO → 着色器用 MV.js 矩阵画出。
 */

import { NGON_PRESETS, buildMesh, paint } from "./geometry.js";
import { bindInteraction } from "./interaction.js";
import { PALETTES, bindUI } from "./ui.js";

const canvas = document.getElementById("gl-canvas");
const hint = document.getElementById("hint");

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

const gl = WebGLUtils.setupWebGL(canvas, { antialias: true, alpha: false });
if (!gl || typeof gl.createVertexArray !== "function") {
  hint.textContent = "当前浏览器没有可用的 WebGL 2.0 上下文。";
  throw new Error("WebGL 2 required");
}

const program = initShaders(gl, "vertex-shader", "fragment-shader");
if (!program || program === -1) {
  throw new Error("shader init failed");
}
gl.useProgram(program);

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

function setPrimitive(name) {
  state.primitive = name;
  if (name !== "points" && state.algorithm === "chaos") {
    state.algorithm = "recursive";
  }
  rebuildGeometry();
  ui.sync();
  updateHint();
}

function setGrowing(next) {
  if (next && state.visible >= state.vertexCount - 0.5) state.visible = 0;
  state.growing = next;
  ui.sync();
}

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

function modelMatrix() {
  if (state.algorithm === "tetra") {
    return mult(rotate(state.yaw, vec3(0, 1, 0)), rotate(state.pitch, vec3(1, 0, 0)));
  }
  const aspect = canvas.width / Math.max(1, canvas.height);
  return mult(translate(state.panX, state.panY, 0), scale(state.zoom / aspect, state.zoom, 1));
}

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

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (state.algorithm === "chaos" && state.growing) {
    const rate = state.vertexCount / 8;
    state.visible = Math.min(state.vertexCount, state.visible + rate * dt);
  }
  if (state.algorithm === "tetra" && !state.dragging) {
    state.yaw += dt * 16;
  }

  resize();
  rebuildGeometry();

  const background = PALETTES[state.palette].background;
  gl.clearColor(background[0], background[1], background[2], background[3]);
  const solid3d = state.algorithm === "tetra" && state.primitive === "triangles";
  if (solid3d) gl.enable(gl.DEPTH_TEST);
  else gl.disable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const model = modelMatrix();
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
