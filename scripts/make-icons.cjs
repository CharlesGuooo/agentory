/**
 * 从 SVG 真源生成 Windows 图标资产。
 *
 *   resources/icon.svg        (>20px 用)
 *   resources/icon-small.svg  (≤20px 用，另画的简化版)
 *        ↓
 *   resources/icons/icon-<n>.png   16/20/24/32/48/64/128/256，全部透明底
 *   resources/icon.ico             多尺寸合一
 *
 * **零依赖**：Electron 自带 Chromium，把 SVG 画进 canvas 再 toDataURL 就有了 PNG。
 * 刻意不用 `capturePage` —— 那条路的 alpha 取决于窗口透明度设置，不可靠；
 * canvas 的 alpha 是确定的，而且能当场把角落像素读出来验。
 *
 * ICO 只是个容器：6 字节头 + 每图 16 字节目录项 + 若干 PNG 块。
 * Windows Vista 起就认 PNG-in-ICO，所以不需要 BMP 编码器。
 *
 *   npx electron scripts/make-icons.cjs
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const RES = path.join(__dirname, "..", "resources");
const PNG_DIR = path.join(RES, "icons");
/** Windows 图标要求的尺寸档。16 和 20 走简化版。 */
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const SMALL_UPTO = 20;

/** 把一段 SVG 画成指定边长的 PNG，并当场检查四角是否真的透明。 */
async function rasterize(win, svg, size) {
  const r = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(${JSON.stringify(svg)});
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = ${size};
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, ${size}, ${size});
    const px = (x, y) => g.getImageData(x, y, 1, 1).data[3];
    const n = ${size} - 1;
    return JSON.stringify({
      png: c.toDataURL("image/png").split(",")[1],
      corners: [px(0,0), px(n,0), px(0,n), px(n,n)],
      center: px(${size} >> 1, ${size} >> 1),
    });
  })()`);
  const { png, corners, center } = JSON.parse(r);
  return { buf: Buffer.from(png, "base64"), corners, center };
}

/** 组装 ICO。图像块原样是 PNG，不转 BMP。 */
function buildIco(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type 1 = icon
  head.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = head.length + dir.length;
  images.forEach((im, i) => {
    const o = i * 16;
    // 256 在这里写 0 —— 这个字段只有 1 字节，规范用 0 表示 256
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o);
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o + 1);
    dir.writeUInt8(0, o + 2); // 调色板数
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(im.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += im.buf.length;
  });

  return Buffer.concat([head, dir, ...images.map((im) => im.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadURL("data:text/html,<body></body>");

  const full = fs.readFileSync(path.join(RES, "icon.svg"), "utf8");
  const small = fs.readFileSync(path.join(RES, "icon-small.svg"), "utf8");
  fs.mkdirSync(PNG_DIR, { recursive: true });

  const images = [];
  let bad = 0;
  for (const size of SIZES) {
    const useSmall = size <= SMALL_UPTO;
    const im = await rasterize(win, useSmall ? small : full, size);
    fs.writeFileSync(path.join(PNG_DIR, `icon-${size}.png`), im.buf);
    images.push({ size, buf: im.buf });

    const clear = im.corners.every((a) => a === 0);
    if (!clear || im.center === 0) bad++;
    process.stdout.write(
      `  ${String(size).padStart(3)}px  ${useSmall ? "简化版" : "完整版"}  ` +
        `${String(im.buf.length).padStart(6)} B  ` +
        `角落 alpha ${im.corners.join(",")} ${clear ? "✓透明" : "✗ 不透明"}  ` +
        `中心 alpha ${im.center}\n`,
    );
  }

  const icoPath = path.join(RES, "icon.ico");
  fs.writeFileSync(icoPath, buildIco(images));

  // 回读验证：用真正的解码器读一遍，而不是相信自己刚写的字节
  const back = nativeImage.createFromPath(icoPath);
  const size = back.getSize();
  process.stdout.write(
    `\n  icon.ico  ${fs.statSync(icoPath).size} B  ${images.length} 个尺寸\n` +
      `  回读：${back.isEmpty() ? "✗ 解码失败" : `✓ ${size.width}×${size.height}`}\n` +
      `  四角透明检查：${bad === 0 ? "✓ 全部通过" : `✗ ${bad} 个尺寸有问题`}\n`,
  );

  app.exit(bad === 0 && !back.isEmpty() ? 0 : 1);
});
