/**
 * 几何生成：不接触 WebGL。
 * 混沌游戏与递归细分各自产出同一份顶点布局，渲染模式只决定怎么画。
 */

/** 正 n 边形顶点，外接圆半径 radius，几何中心在原点，y 轴向上。 */
export function regularPolygon(n, radius = 0.86) {
  const vertices = [];
  for (let i = 0; i < n; i += 1) {
    const angle = Math.PI / 2 + (2 * Math.PI * i) / n;
    vertices.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return vertices;
}

/**
 * 各边形混沌游戏的推荐参数。
 * ratio 是朝选中顶点移动的比例：p ← (1-ratio)*p + ratio*v。
 * 三角形 ratio = 1/2 就是题目中的 p = (p + v) / 2。
 */
export const NGON_PRESETS = {
  3: { ratio: 0.5, restriction: "none" },
  4: { ratio: 0.5, restriction: "no-repeat" },
  5: { ratio: 0.618034, restriction: "no-repeat" },
  6: { ratio: 2 / 3, restriction: "no-neighbor" },
};

function midpoint(a, b) {
  return [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    ((a[2] || 0) + (b[2] || 0)) / 2,
  ];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** 朝原点外侧的单位法线，四面体以原点为中心时用于区分正反面。 */
function outwardNormal(a, b, c) {
  let n = cross(sub(b, a), sub(c, a));
  const center = [
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
  ];
  if (dot(n, center) < 0) n = [-n[0], -n[1], -n[2]];
  return normalize(n);
}

function pickVertex(n, last, restriction, rand) {
  if (restriction === "none" || last < 0) {
    return Math.floor(rand() * n);
  }
  if (restriction === "no-repeat") {
    let index = Math.floor(rand() * (n - 1));
    if (index >= last) index += 1;
    return index;
  }
  const forbidden = new Set([(last + 1) % n, (last - 1 + n) % n]);
  const options = [];
  for (let i = 0; i < n; i += 1) {
    if (!forbidden.has(i)) options.push(i);
  }
  return options[Math.floor(rand() * options.length)];
}

/**
 * 混沌游戏。
 * 从多边形内部一点出发，反复朝随机顶点走一步。
 * 三角形且 ratio 为 0.5 时，吸引子是 Sierpinski 垫片。
 * 丢弃前若干步，避免起点附近的过渡点。
 */
export function chaosGame({
  vertices,
  count,
  ratio,
  restriction = "none",
  rand = Math.random,
}) {
  const n = vertices.length;
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i += 1) {
    px += vertices[i][0];
    py += vertices[i][1];
  }
  px /= n;
  py /= n;

  let last = -1;
  const warmup = 24;
  const positions = new Float32Array(count * 3);
  const colorIndex = new Uint8Array(count);
  const normals = new Float32Array(count * 3);

  for (let i = 0; i < count + warmup; i += 1) {
    const index = pickVertex(n, last, restriction, rand);
    const vertex = vertices[index];
    px = (1 - ratio) * px + ratio * vertex[0];
    py = (1 - ratio) * py + ratio * vertex[1];
    last = index;
    if (i < warmup) continue;
    const k = i - warmup;
    positions[k * 3] = px;
    positions[k * 3 + 1] = py;
    positions[k * 3 + 2] = 0;
    colorIndex[k] = index;
    normals[k * 3 + 2] = 1;
  }

  return { positions, normals, colorIndex, count };
}

/**
 * 递归细分一个三角形。
 * depth = 0 时保留该三角形；否则连接三边中点，
 * 只对三个角上的子三角形继续递归，中间那块挖空。
 * 返回的每个小三角形带一个 colorId，对应它属于最初的哪一个角。
 */
export function subdivideTriangle(vertices, depth) {
  const triangles = [];

  function subdivide(a, b, c, level, colorId) {
    if (level === 0) {
      triangles.push({ corners: [a, b, c], colorId });
      return;
    }
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    const next = level - 1;
    subdivide(a, ab, ca, next, level === depth ? 0 : colorId);
    subdivide(ab, b, bc, next, level === depth ? 1 : colorId);
    subdivide(ca, bc, c, next, level === depth ? 2 : colorId);
  }

  const [a, b, c] = vertices;
  subdivide(
    [a[0], a[1], 0],
    [b[0], b[1], 0],
    [c[0], c[1], 0],
    depth,
    0,
  );
  return triangles;
}

/** 教材中的正四面体四个顶点，已落在以原点为中心的球面上。 */
const TETRA_VERTICES = [
  [0, 0, -1],
  [0, 0.942809041582, 0.333333333333],
  [-0.816496580928, -0.471404520791, 0.333333333333],
  [0.816496580928, -0.471404520791, 0.333333333333],
];

/**
 * 三维垫片：每次把四面体分成四个角上的小四面体，去掉中间的八面体。
 * 深度 0 输出四个外表面。
 */
export function subdivideTetrahedron(depth) {
  const faces = [];

  function subdivide(a, b, c, d, level, colorId) {
    if (level === 0) {
      faces.push(
        { corners: [a, c, b], colorId },
        { corners: [a, b, d], colorId },
        { corners: [a, d, c], colorId },
        { corners: [b, c, d], colorId },
      );
      return;
    }
    const ab = midpoint(a, b);
    const ac = midpoint(a, c);
    const ad = midpoint(a, d);
    const bc = midpoint(b, c);
    const bd = midpoint(b, d);
    const cd = midpoint(c, d);
    const next = level - 1;
    subdivide(a, ab, ac, ad, next, level === depth ? 0 : colorId);
    subdivide(ab, b, bc, bd, next, level === depth ? 1 : colorId);
    subdivide(ac, bc, c, cd, next, level === depth ? 2 : colorId);
    subdivide(ad, bd, cd, d, next, level === depth ? 3 : colorId);
  }

  const [a, b, c, d] = TETRA_VERTICES;
  subdivide(a, b, c, d, depth, 0);
  return faces;
}

function pushVertex(positions, normals, colorIndex, cursor, point, normal, colorId) {
  positions[cursor * 3] = point[0];
  positions[cursor * 3 + 1] = point[1];
  positions[cursor * 3 + 2] = point[2] || 0;
  normals[cursor * 3] = normal[0];
  normals[cursor * 3 + 1] = normal[1];
  normals[cursor * 3 + 2] = normal[2];
  colorIndex[cursor] = colorId;
  return cursor + 1;
}

/** 把三角形列表展开成点/线/面共用的顶点数组。线和面的顶点顺序不同。 */
function expandFaces(faces, primitive) {
  const perFace = primitive === "lines" ? 6 : 3;
  const count = faces.length * perFace;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colorIndex = new Uint8Array(count);
  let cursor = 0;

  for (const face of faces) {
    const [a, b, c] = face.corners;
    const normal = outwardNormal(a, b, c);
    const id = face.colorId;
    if (primitive === "lines") {
      const edges = [a, b, b, c, c, a];
      for (const point of edges) {
        cursor = pushVertex(positions, normals, colorIndex, cursor, point, normal, id);
      }
    } else {
      cursor = pushVertex(positions, normals, colorIndex, cursor, a, normal, id);
      cursor = pushVertex(positions, normals, colorIndex, cursor, b, normal, id);
      cursor = pushVertex(positions, normals, colorIndex, cursor, c, normal, id);
    }
  }

  return { positions, normals, colorIndex, count };
}

/**
 * 按当前参数生成一份网格。
 * 混沌游戏忽略 primitive（它只有点）；递归与四面体按点/线/面展开同一组三角形。
 */
export function buildMesh(params) {
  if (params.algorithm === "chaos") {
    const vertices = regularPolygon(params.sides);
    const preset = NGON_PRESETS[params.sides];
    const ratio = params.sides === 3 ? preset.ratio : params.ratio;
    const restriction = params.sides === 3 ? preset.restriction : params.restriction;
    return chaosGame({
      vertices,
      count: params.vertexCount,
      ratio,
      restriction,
      rand: params.rand,
    });
  }

  if (params.algorithm === "tetra") {
    return expandFaces(subdivideTetrahedron(params.depth), params.primitive);
  }

  const corners = regularPolygon(3).map((p) => [p[0], p[1], 0]);
  return expandFaces(subdivideTriangle(corners, params.depth), params.primitive);
}

export function paint(colorIndex, palette) {
  const colors = new Float32Array(colorIndex.length * 3);
  for (let i = 0; i < colorIndex.length; i += 1) {
    const rgb = palette[colorIndex[i] % palette.length];
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }
  return colors;
}
