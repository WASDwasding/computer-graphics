/**
 * 文件：js/ui.js
 *
 * 这个文件负责左侧参数面板。按钮和滑条的 HTML 在 index.html，
 * 这里负责：读控件、写进 state、把当前用不到的滑条灰掉。
 *
 * 顶点数只在混沌游戏里生效，递归深度只在细分和四面体里生效。
 * 换配色不重算顶点，只通知 main.js 重写颜色缓冲。
 * 键盘改了模式之后，main.js 会调用这里返回的 sync()，让单选按钮跟上。
 */

/**
 * 三套配色。colors[i] 是第 i 个角的 RGB，范围 0 到 1，直接送进着色器。
 * background 是清屏颜色。换配色不改几何，只重写颜色缓冲。
 */
export const PALETTES = {
  classic: {
    label: "经典",
    background: [0.07, 0.08, 0.1, 1],
    colors: [
      [0.93, 0.94, 0.96],
      [0.89, 0.29, 0.27],
      [0.29, 0.72, 0.91],
      [0.95, 0.76, 0.28],
      [0.45, 0.78, 0.48],
      [0.72, 0.48, 0.9],
    ],
  },
  warm: {
    label: "暖色",
    background: [0.16, 0.09, 0.06, 1],
    colors: [
      [0.98, 0.9, 0.72],
      [0.86, 0.42, 0.18],
      [0.93, 0.67, 0.28],
      [0.72, 0.28, 0.22],
      [0.96, 0.8, 0.45],
      [0.55, 0.32, 0.18],
    ],
  },
  neon: {
    label: "霓虹",
    background: [0.03, 0.05, 0.12, 1],
    colors: [
      [0.55, 0.95, 0.98],
      [0.98, 0.32, 0.72],
      [0.45, 1, 0.62],
      [0.98, 0.85, 0.28],
      [0.62, 0.48, 1],
      [0.3, 0.7, 1],
    ],
  },
};

const PRIMITIVES = ["points", "lines", "triangles"];

function readNumber(id) {
  return document.getElementById(id);
}

export function bindUI(state, hooks) {
  const algorithm = document.getElementById("algorithm");
  const vertexCount = readNumber("vertex-count");
  const depth = readNumber("depth");
  const pointSize = readNumber("point-size");
  const sides = document.getElementById("sides");
  const ratio = readNumber("ratio");
  const restriction = document.getElementById("restriction");
  const palette = document.getElementById("palette");
  const growing = document.getElementById("growing");
  const formula = document.getElementById("formula");
  const status = document.getElementById("status");

  function writeReadout(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  /**
   * 把 state 写回控件，并按当前算法禁用用不上的滑条。
   * 顶点数只对混沌游戏有意义；递归深度只对细分和四面体有意义。
   * 三角形垫片的步长和选点规则是固定的，所以边数为 3 时那两项灰掉。
   */
  function sync() {
    algorithm.value = state.algorithm; // 下拉框显示当前算法
    for (const name of PRIMITIVES) {
      // 三个单选框里，只有和 state.primitive 同名的那个打勾。键盘切换后也靠这行把勾选补上。
      document.getElementById(`mode-${name}`).checked = state.primitive === name;
    }
    vertexCount.value = String(state.vertexCount); // 滑条的 value 必须是字符串
    depth.value = String(state.depth);
    pointSize.value = String(state.pointSize);
    sides.value = String(state.sides);
    ratio.value = String(state.ratio);
    restriction.value = state.restriction;
    palette.value = state.palette;
    growing.checked = state.growing;

    // 滑条旁边的数字。点大小和步长保留小数，顶点数和深度是整数。
    writeReadout("vertex-count-value", String(state.vertexCount));
    writeReadout("depth-value", String(state.depth));
    writeReadout("point-size-value", state.pointSize.toFixed(1));
    writeReadout("ratio-value", state.ratio.toFixed(3));

    const chaosPoints = state.algorithm === "chaos";
    vertexCount.disabled = !chaosPoints; // 不是混沌游戏时，顶点数滑条不能拖
    document.getElementById("vertex-count-field").classList.toggle("is-disabled", !chaosPoints);

    const usesDepth = state.algorithm !== "chaos"; // 递归细分和四面体才用深度
    depth.disabled = !usesDepth;
    document.getElementById("depth-field").classList.toggle("is-disabled", !usesDepth);

    // 边数、步长、选点约束只在“混沌游戏且不是三角形”时能改。三角形的公式是作业规定的。
    const ngon = chaosPoints && state.sides !== 3;
    sides.disabled = !chaosPoints;
    ratio.disabled = !ngon;
    restriction.disabled = !ngon;
    document.getElementById("ngon-field").classList.toggle("is-disabled", !chaosPoints);
    document.getElementById("ratio-field").classList.toggle("is-disabled", !ngon);
    document.getElementById("restriction-field").classList.toggle("is-disabled", !ngon);

    for (const name of PRIMITIVES) {
      document.getElementById(`mode-${name}`).disabled = false;
    }

    if (state.algorithm === "chaos" && state.sides === 3) {
      formula.textContent = "混沌游戏：p ← (p + 随机顶点) / 2，反复迭代后落在垫片上。";
    } else if (state.algorithm === "chaos") {
      formula.textContent = "n 边形混沌游戏：p ← (1 − r)·p + r·顶点。换边数或步长可以比较吸引子。";
    } else if (state.algorithm === "tetra") {
      formula.textContent = "四面体垫片：连接棱的中点，保留四个角上的小四面体，去掉中间八面体。";
    } else {
      formula.textContent = "递归细分：三边取中点，去掉中间三角形，对三个角继续细分到指定深度。";
    }
  }

  // 切回混沌游戏时强制成点模式，因为随机点没有线框和实体。
  algorithm.addEventListener("change", () => {
    state.algorithm = algorithm.value; // "chaos"、"recursive" 或 "tetra"
    if (state.algorithm === "chaos") state.primitive = "points"; // 随机点没有线和面
    hooks.onGeometry(); // 通知 main.js 按新算法重算顶点
    sync(); // 灰掉现在用不到的滑条
  });

  for (const name of PRIMITIVES) {
    document.getElementById(`mode-${name}`).addEventListener("change", () => {
      // 一组单选框切换时，被取消的那个也会触发 change。只处理新被选中的那个。
      if (!document.getElementById(`mode-${name}`).checked) return;
      hooks.setPrimitive(name);
    });
  }

  // input 在拖动过程中就触发，所以点数和深度会跟着滑条实时重算。
  vertexCount.addEventListener("input", () => {
    state.vertexCount = Number(vertexCount.value); // 滑条给的是字符串，转成数字再交给几何
    writeReadout("vertex-count-value", String(state.vertexCount));
    hooks.onGeometry(); // 点数变了，混沌游戏要整批重算
  });

  depth.addEventListener("input", () => {
    state.depth = Number(depth.value);
    writeReadout("depth-value", String(state.depth));
    hooks.onGeometry();
  });

  // 点大小只是一个 uniform，不用重新生成顶点。
  pointSize.addEventListener("input", () => {
    state.pointSize = Number(pointSize.value);
    writeReadout("point-size-value", state.pointSize.toFixed(1));
    // 这里不调用 onGeometry。点大小下一帧作为 uniform 传给着色器，顶点数组不用重算。
  });

  sides.addEventListener("change", () => {
    state.sides = Number(sides.value);
    hooks.onSides(); // main.js 会套上这个边数的推荐步长和选点规则，再重算
    sync(); // 边数变成 3 时要把步长滑条灰掉
  });

  ratio.addEventListener("input", () => {
    state.ratio = Number(ratio.value);
    writeReadout("ratio-value", state.ratio.toFixed(3));
    hooks.onGeometry();
  });

  restriction.addEventListener("change", () => {
    state.restriction = restriction.value;
    hooks.onGeometry();
  });

  palette.addEventListener("change", () => {
    state.palette = palette.value;
    hooks.onPalette(); // 只重写颜色缓冲，不重跑混沌游戏，点的位置保持不变
  });

  growing.addEventListener("change", () => {
    hooks.setGrowing(growing.checked);
  });

  document.getElementById("reset-view").addEventListener("click", () => {
    hooks.onResetView();
  });

  sync(); // 第一次打开页面时，按默认 state 把该灰的控件灰掉

  return {
    sync, // 键盘改了模式后，main.js 用它把单选框和说明文字刷成一致
    setStatus(text) {
      status.textContent = text; // 面板底部那一行“生长中 · 1234 / 20000”
    },
  };
}
