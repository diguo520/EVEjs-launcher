#!/usr/bin/env python3
"""按启动器 LOGO（ui/src/components/shell/logo-mark.tsx 的六边形标识）生成图标。
外六边形=青色 primary、内六边形=琥珀 telemetry、中心点，画在启动器底色 #0B1120 上。
产出 icon-src.png（托盘用）与 icon.ico（任务栏/进程用，多尺寸）。
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "src-tauri", "icons")

OUTER = [(20, 3), (36, 12), (36, 28), (20, 37), (4, 28), (4, 12)]
INNER = [(20, 9), (31, 15), (31, 25), (20, 31), (9, 25), (9, 15)]
CENTER = (20, 20)

PRIMARY = (0, 212, 255)
TELEMETRY = (255, 184, 0)
BG = (11, 17, 32)

S = 512
SCALE = S / 40.0

def p(pt):
    return (pt[0] * SCALE, pt[1] * SCALE)

def draw(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, size - 1, size - 1], fill=BG)
    outer = [p(pt) for pt in OUTER]
    inner = [p(pt) for pt in INNER]
    # 外六边形：青色 8% 填充 + 青色描边
    d.polygon(outer, fill=PRIMARY + (int(255 * 0.08),))
    d.line(outer + outer[:1], fill=PRIMARY, width=max(1, round(1.5 * SCALE)))
    # 内六边形：琥珀描边
    d.line(inner + inner[:1], fill=TELEMETRY + (int(255 * 0.65),), width=max(1, round(1.0 * SCALE)))
    cx, cy = CENTER[0] * SCALE, CENTER[1] * SCALE
    # 外圈装饰环：双圆挖孔（先画，中心点最后覆盖上去）
    r = 6 * SCALE
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=PRIMARY + (int(255 * 0.45),))
    d.ellipse([cx - r + 0.5 * SCALE, cy - r + 0.5 * SCALE, cx + r - 0.5 * SCALE, cy + r - 0.5 * SCALE], fill=BG)
    # 中心实心点（最后画，保证不被环的挖孔盖掉）
    d.ellipse([cx - 2.5 * SCALE, cy - 2.5 * SCALE, cx + 2.5 * SCALE, cy + 2.5 * SCALE], fill=PRIMARY)
    return img

def main():
    big = draw(S)
    png = os.path.join(ICONS, "icon-src.png")
    big.save(png)
    print("png:", png)
    ico = os.path.join(ICONS, "icon.ico")
    big.save(ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print("ico:", ico)

if __name__ == "__main__":
    main()
