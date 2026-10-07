/**
 * 文件：js/geometry.js
 *
 * 这个文件只负责算图形，完全不碰 WebGL，也不读鼠标。
 * main.js 把面板上的算法、点数、深度传进来，这里返回三份数组：
 *   positions   每个顶点的 xyz
 *   colorIndex  这个顶点属于第几个角，用来上色
 *   normals     法线，只有三维实体光照才用
 *
 * 里面有两条必做路径，外加一个选做：
 *   chaosGame            混沌游戏。反复执行 p ← (p + 随机顶点) / 2
 *   subdivideTriangle    递归细分。三边取中点，丢掉中间的三角形
 *   subdivideTetrahedron 选做。同样的想法用在四面体上，丢掉中间的八面体
 *
 * 老师问“顶点从哪来”：先在这个文件里用 Float32Array 算好，
 * 再由 main.js 的 gl.bufferData 拷进显卡。
 */

/**
 * 正 n 边形的顶点。
 * 圆心在原点，第一个顶点在正上方（角度从 90° 起），然后逆时针转。
 * 半径 0.86 是为了放进裁剪空间 [-1, 1]，四周留一点边。
 * 三角形的三个顶点重心也在原点，所以垫片画出来是居中的。
 */
export function regularPolygon(n, radius = 0.86) {
  const vertices = [];
  for (let i = 0; i < n; i += 1) {
    // Math.PI / 2 是 90°，所以 i = 0 的顶点在正上方，三角形尖朝上。
    // 后面每个顶点再转 360°/n。角度用弧度，因为 Math.cos / Math.sin 只接受弧度。
    const angle = Math.PI / 2 + (2 * Math.PI * i) / n;
    // x = r·cosθ，y = r·sinθ，点落在圆上，圆心是原点。
    vertices.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return vertices;
}

/**
 * 换边数时用的默认参数。
 * ratio 是“朝选中顶点走完全程的百分之多少”。
 * 公式统一写成 p ← (1 - ratio) * p + ratio * 顶点。
 * 三角形 ratio = 0.5，化简后就是作业要求的 p = (p + 顶点) / 2。
 *
 * restriction 是选点限制。边数大于 3 时如果每次都任意选，
 * 点会把多边形内部填满，看不出分形，所以要加限制。
 */
export const NGON_PRESETS = {
  3: { ratio: 0.5, restriction: "none" },
  4: { ratio: 0.5, restriction: "no-repeat" },
  5: { ratio: 0.618034, restriction: "no-repeat" },
  6: { ratio: 2 / 3, restriction: "no-neighbor" },
};

/** 线段中点。递归细分时，每条边都取这个点再连起来。 */
function midpoint(a, b) {
  return [
    (a[0] + b[0]) / 2, // x 中点
    (a[1] + b[1]) / 2, // y 中点
    // 二维点没有 z，a[2] 是 undefined，用 0 代替，避免算出 NaN。
    ((a[2] || 0) + (b[2] || 0)) / 2,
  ];
}

/** 向量 a - b。后面用两条边相减，得到从 a 出发的两条边。 */
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** 叉积。两个边向量叉乘得到三角形的法线方向。 */
function cross(a, b) {
  // 标准叉积公式。结果垂直于 a 和 b，就是三角形所在平面的法线。
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** 点积。结果大于 0 表示两个向量夹角是锐角，朝向大致相同。 */
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** 变成单位向量。长度接近 0 时用 1，避免除以 0。 */
function normalize(v) {
  // hypot 是三维长度 √(x²+y²+z²)。长度为 0 时改用 1，否则下一行会除以 0。
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * 三角形的单位法线，并翻到朝外。
 * 四面体以原点为中心，面的中心大致指向外侧。
 * 若法线和“原点到面心”的点积是负的，说明法线朝里，取反。
 * 二维垫片不开光照，这个法线只是占位；三维实体才会用它算明暗。
 */
function outwardNormal(a, b, c) {
  // 边 ab、ac 的叉积。顶点顺序反过来，法线就会朝反方向。
  let n = cross(sub(b, a), sub(c, a));
  const center = [
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
  ];
  // 四面体中心在原点，面心向量大致指向外面。
  // 点积为负说明法线朝里，三个分量全部取反。
  if (dot(n, center) < 0) n = [-n[0], -n[1], -n[2]];
  return normalize(n);
}

/**
 * 这一步选多边形的哪个顶点。
 * none：0 到 n-1 里均匀随机，三角形垫片用这个。
 * no-repeat：不能选和上一次相同的顶点。从 n-1 个候选里抽，
 *   抽到的编号如果落在“上一次”之后，就加 1，从而跳过 last。
 * no-neighbor：不能选左右相邻的两个顶点，六边形用这个才不会糊成一片。
 */
function pickVertex(n, last, restriction, rand) {
  // rand() 在 [0, 1)。乘 n 再 floor，得到 0、1、…、n-1，每个顶点概率相同。
  // last < 0 是第一步，没有“上一次”，所以也不受限制。
  if (restriction === "none" || last < 0) {
    return Math.floor(rand() * n);
  }
  if (restriction === "no-repeat") {
    // 只有 n-1 个合法顶点。先在 0..n-2 里抽，再把落在 last 以及它后面的编号加 1，
    // 这样 last 被跳过，其余编号仍然均匀。例如 n=3、last=1 时，抽到 0 仍是 0，抽到 1 变成 2。
    let index = Math.floor(rand() * (n - 1));
    if (index >= last) index += 1;
    return index;
  }
  // (last+1)%n 是逆时针邻居，(last-1+n)%n 是顺时针邻居。加 n 再取模，避免 last 为 0 时出现 -1。
  const forbidden = new Set([(last + 1) % n, (last - 1 + n) % n]);
  const options = [];
  for (let i = 0; i < n; i += 1) {
    if (!forbidden.has(i)) options.push(i);
  }
  return options[Math.floor(rand() * options.length)];
}

/**
 * 混沌游戏。
 *
 * 起点取多边形顶点的平均值，也就是中心，保证一开始就在图形内部。
 * 然后循环 count + 24 次：
 *   1. 按规则随机选一个顶点
 *   2. 当前点朝那个顶点走 ratio 这么一段
 *   3. 前 24 次不记录。起点附近的点还没落到吸引子上，画出来会脏
 * 三角形且 ratio 为 0.5 时，落点就是 Sierpinski 垫片。
 *
 * 返回三份等长数据，第 k 个点占三个连续浮点数（x, y, z）：
 *   positions  坐标，z 一律是 0，因为这是平面图形
 *   colorIndex 这次选中的顶点编号，换配色时不用重算坐标
 *   normals    平面法线 (0, 0, 1)，二维不用光照
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
  px /= n; // 顶点 x 的平均，也就是几何中心
  py /= n;

  let last = -1; // -1 表示还没有选过顶点，第一步不受“不重复”限制
  const warmup = 24;
  // 每个点存 x、y、z 三个 float，所以长度是点数的 3 倍。Float32Array 是 WebGL 能直接上传的类型。
  const positions = new Float32Array(count * 3);
  const colorIndex = new Uint8Array(count); // 每个点只存一个角的编号，0 到 n-1
  const normals = new Float32Array(count * 3); // 新建时全是 0

  for (let i = 0; i < count + warmup; i += 1) {
    const index = pickVertex(n, last, restriction, rand);
    const vertex = vertices[index];
    // 保留当前点的 (1-ratio)，再混进目标顶点的 ratio。
    // ratio 为 0.5 时：px = 0.5*px + 0.5*vx = (px + vx) / 2，就是作业里的公式。
    px = (1 - ratio) * px + ratio * vertex[0];
    py = (1 - ratio) * py + ratio * vertex[1];
    last = index; // 下一步的“不能重复 / 不能相邻”要看这次选了谁
    if (i < warmup) continue; // 前 24 个点只用来走进吸引子，不写入数组
    const k = i - warmup; // 扣掉预热后，这才是数组里的第 k 个点
    positions[k * 3] = px; // 第 k 个点的 x 放在下标 3k
    positions[k * 3 + 1] = py; // y 紧跟在 x 后面
    positions[k * 3 + 2] = 0; // 平面图形，z 固定为 0
    colorIndex[k] = index; // 记住这次走向了哪个顶点，三个角就会是三种颜色
    normals[k * 3 + 2] = 1; // x、y 保持默认 0，法线就是 (0, 0, 1)，垂直于屏幕
  }

  return { positions, normals, colorIndex, count };
}

/**
 * 递归细分一个三角形，得到垫片。
 *
 * subdivide(a, b, c, level)：
 *   level 为 0：这个三角形留下来，不再挖。
 *   否则取三边中点 ab、bc、ca。原来的三角形被分成四块：
 *     角 a 的小三角形 (a, ab, ca)
 *     角 b 的小三角形 (ab, b, bc)
 *     角 c 的小三角形 (ca, bc, c)
 *     中间那块 (ab, bc, ca) 不递归，等于挖空，这就是垫片的洞。
 * 深度 d 最后有 3^d 个小三角形。深度 5 是 243 个，深度 6 是 729 个。
 *
 * colorId 记住这个小三角形属于最初的哪一个角。
 * 只在最外层那一次递归时分配 0、1、2，更深层把这个编号传下去，
 * 所以三个大角会各是一种颜色。
 */
export function subdivideTriangle(vertices, depth) {
  const triangles = [];

  function subdivide(a, b, c, level, colorId) {
    if (level === 0) {
      // 不再往下分。corners 的顺序要保持，后面展开成三角形时靠这个顺序定正反面。
      triangles.push({ corners: [a, b, c], colorId });
      return;
    }
    const ab = midpoint(a, b); // 边 ab 的中点
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    const next = level - 1;
    // 下面三次调用只覆盖三个角。中间三角形 (ab, bc, ca) 没有调用，所以被挖掉。
    // level === depth 只在最外层成立，这时才把三个角编号成 0、1、2。
    // 更里面的层把已经分好的 colorId 原样传下去，同一个大角始终同色。
    subdivide(a, ab, ca, next, level === depth ? 0 : colorId);
    subdivide(ab, b, bc, next, level === depth ? 1 : colorId);
    subdivide(ca, bc, c, next, level === depth ? 2 : colorId);
  }

  const [a, b, c] = vertices;
  subdivide(
    [a[0], a[1], 0], // 补上 z = 0，和后面的三维顶点格式一致
    [b[0], b[1], 0],
    [c[0], c[1], 0],
    depth, // 还要再细分这么多层
    0, // 最外层的颜色编号会在第一次递归里被 0、1、2 覆盖
  );
  return triangles;
}

/**
 * 正四面体的四个顶点，来自教材里的 gasket 例子，已经以原点为中心。
 * 一个在后下方，三个在前面围成一圈。
 */
const TETRA_VERTICES = [
  [0, 0, -1],
  [0, 0.942809041582, 0.333333333333],
  [-0.816496580928, -0.471404520791, 0.333333333333],
  [0.816496580928, -0.471404520791, 0.333333333333],
];

/**
 * 三维垫片，思想和二维一样，只是“挖掉中间”的形状不同。
 *
 * 四面体有 4 个顶点和 6 条棱。每条棱取中点后，四个角上各剩一个小四面体，
 * 中间是一个八面体。只递归四个角，八面体丢掉，洞就出来了。
 * 深度 d 有 4^(d+1) 个三角形面。深度 0 就是原来的 4 个面。
 *
 * 到了最细一层，每个小四面体输出 4 个三角面。
 * colorId 同样只在最外层分成 0、1、2、3，对应四个角。
 */
export function subdivideTetrahedron(depth) {
  const faces = [];

  function subdivide(a, b, c, d, level, colorId) {
    if (level === 0) {
      // 一个四面体的四个面。顶点顺序按“从外面看是逆时针”来排，法线才会朝外。
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
    // 四个参数是小四面体的四个顶点，分别贴在原来的角 a、b、c、d 上。
    // 由六条棱中点围成的中间八面体没有出现在任何一次调用里，等于被丢掉。
    subdivide(a, ab, ac, ad, next, level === depth ? 0 : colorId);
    subdivide(ab, b, bc, bd, next, level === depth ? 1 : colorId);
    subdivide(ac, bc, c, cd, next, level === depth ? 2 : colorId);
    subdivide(ad, bd, cd, d, next, level === depth ? 3 : colorId);
  }

  const [a, b, c, d] = TETRA_VERTICES;
  subdivide(a, b, c, d, depth, 0);
  return faces;
}

/**
 * 把一个顶点写进三份平行数组，并让游标加 1。
 * 位置、法线都是每顶点 3 个 float，所以下标是 cursor * 3。
 */
function pushVertex(positions, normals, colorIndex, cursor, point, normal, colorId) {
  // cursor 是“第几个顶点”。坐标数组里它占 3 个格子，所以起点下标是 cursor * 3。
  positions[cursor * 3] = point[0];
  positions[cursor * 3 + 1] = point[1];
  positions[cursor * 3 + 2] = point[2] || 0;
  normals[cursor * 3] = normal[0];
  normals[cursor * 3 + 1] = normal[1];
  normals[cursor * 3 + 2] = normal[2];
  colorIndex[cursor] = colorId; // 颜色编号每个顶点只有一个，不必乘 3
  return cursor + 1; // 调用方用返回值继续写下个顶点
}

/**
 * 把“三角形列表”摊成显卡能直接画的顶点序列。
 *
 * gl.TRIANGLES：每个三角形 3 个顶点，按顺序画成一个填充三角形。
 * gl.POINTS：顶点数和三角形模式一样，只是绘制时改用点图元，所以点和实体共用这份数据。
 * gl.LINES：线段必须成对。一条边要两个顶点，三条边就是 6 个顶点：
 *   a-b、b-c、c-a。不能只给 3 个点，否则 LINES 不知道谁和谁连。
 */
function expandFaces(faces, primitive) {
  // 线框一条边 2 个顶点，三条边共 6 个；填充三角形只要按顺序给 3 个顶点。
  const perFace = primitive === "lines" ? 6 : 3;
  const count = faces.length * perFace;
  const positions = new Float32Array(count * 3); // 每个顶点再占 xyz 三个 float
  const normals = new Float32Array(count * 3);
  const colorIndex = new Uint8Array(count);
  let cursor = 0; // 下一个要写入的顶点序号

  for (const face of faces) {
    const [a, b, c] = face.corners;
    const normal = outwardNormal(a, b, c); // 这个面的三个顶点共用同一条法线
    const id = face.colorId;
    if (primitive === "lines") {
      // gl.LINES 按 (0,1)、(2,3)、(4,5) 配对。所以要写成 a,b, b,c, c,a，而不是只给 a,b,c。
      const edges = [a, b, b, c, c, a];
      for (const point of edges) {
        cursor = pushVertex(positions, normals, colorIndex, cursor, point, normal, id);
      }
    } else {
      // 实体用这三个点画一个三角形；点模式绘制时换 gl.POINTS，数据不用另做一份。
      cursor = pushVertex(positions, normals, colorIndex, cursor, a, normal, id);
      cursor = pushVertex(positions, normals, colorIndex, cursor, b, normal, id);
      cursor = pushVertex(positions, normals, colorIndex, cursor, c, normal, id);
    }
  }

  return { positions, normals, colorIndex, count };
}

/**
 * 按当前面板参数挑一种算法，返回可以上传的网格。
 * 混沌游戏没有边和面，primitive 被忽略。
 * 三角形垫片固定用推荐的 ratio 和“任意顶点”，避免滑条把必做图形改坏。
 */
export function buildMesh(params) {
  if (params.algorithm === "chaos") {
    const vertices = regularPolygon(params.sides); // sides=3 就是等边三角形的三个顶点
    const preset = NGON_PRESETS[params.sides];
    // 三角形必须锁死成 1/2 和“任意顶点”，否则滑条会把必做的垫片改成别的图形。
    const ratio = params.sides === 3 ? preset.ratio : params.ratio;
    const restriction = params.sides === 3 ? preset.restriction : params.restriction;
    return chaosGame({
      vertices,
      count: params.vertexCount, // 面板上的“顶点数”，至少 5000
      ratio,
      restriction,
      rand: params.rand,
    });
  }

  if (params.algorithm === "tetra") {
    // primitive 为 "lines" 时每个面展开成 6 个顶点，否则是 3 个。
    return expandFaces(subdivideTetrahedron(params.depth), params.primitive);
  }

  // 二维递归只对三角形做。map 给每个顶点补上 z = 0。
  const corners = regularPolygon(3).map((p) => [p[0], p[1], 0]);
  return expandFaces(subdivideTriangle(corners, params.depth), params.primitive);
}

/**
 * 把“顶点属于第几个角”换成真正的 RGB。
 * 配色只改颜色缓冲，不重新跑混沌游戏，所以换颜色时点的位置不变。
 */
export function paint(colorIndex, palette) {
  const colors = new Float32Array(colorIndex.length * 3); // 每个顶点输出 r、g、b
  for (let i = 0; i < colorIndex.length; i += 1) {
    // colorIndex[i] 是角的编号。取余是为了编号超过配色个数时还能循环用颜色。
    const rgb = palette[colorIndex[i] % palette.length];
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }
  return colors;
}
