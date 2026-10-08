# 计算机图形学

课程作业仓库。页面是静态的，用浏览器直接打开即可。

| 作业 | 内容 | 入口 |
|---|---|---|
| AP1 | 交互式 2D 分形 | [在线运行](https://wasdwasding.github.io/computer-graphics/AP-1/) · [说明](AP-1/README.md) |

本地查看 AP1：

```bash
python3 -m http.server 8080
```

然后打开 <http://localhost:8080/AP-1/>。

## AI 工具

AP1 的页面、几何与交互代码、中文注释和 `AP-1/README.md`，使用 Cursor 中的 Grok 4.7 生成，并在本地运行检查后提交。

`AP-1/Common/` 下的 `MV.js`、`initShaders.js`、`webgl-utils.js` 来自教材配套代码，不是 AI 生成的。`webgl-utils.js` 里为了优先创建 WebGL 2 上下文，增加了 `webgl2` 这一项探测。
