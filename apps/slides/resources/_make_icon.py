from PIL import Image, ImageDraw, ImageFont
import os, struct, io

OUT = r"D:\py\pptx-presenter\apps\slides\resources\icon.ico"
RED = (226, 75, 74, 255)     # 干净的红
WHITE = (255, 255, 255, 255)

def font_for(n):
    for p in [r"C:\Windows\Fonts\arial.ttf",
              r"C:\Windows\Fonts\segui.ttf",
              r"C:\Windows\Fonts\msyh.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, int(n * 0.60))
            except Exception:
                pass
    return ImageFont.load_default()

def draw_icon(N):
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 圆角红底
    r = int(N * 0.20)
    d.rounded_rectangle([0, 0, N - 1, N - 1], radius=r, fill=RED)
    # 字母 P（左侧）
    f = font_for(N)
    bb = d.textbbox((0, 0), "P", font=f)
    pw = bb[2] - bb[0]
    ph = bb[3] - bb[1]
    px = int(N * 0.10)
    py = int((N - ph) / 2) - bb[1]
    d.text((px, py), "P", font=f, fill=WHITE)
    # 向上的箭头（右侧，矢量绘制，不依赖字体字形）
    stem_x = int(N * 0.74)
    stem_w = max(2, int(N * 0.07))
    top_y = int(N * 0.30)
    bot_y = int(N * 0.74)
    d.rectangle([stem_x - stem_w // 2, top_y, stem_x + stem_w // 2, bot_y], fill=WHITE)
    hw = int(N * 0.17)
    head_top = top_y - int(N * 0.12)
    head_base = top_y + int(N * 0.05)
    d.polygon([(stem_x, head_top), (stem_x - hw, head_base), (stem_x + hw, head_base)], fill=WHITE)
    return img

sizes = [16, 24, 32, 48, 64, 128, 256]
images = [draw_icon(s) for s in sizes]

# 手工组装多尺寸 ICO（每个尺寸存为 PNG 帧，Windows 按需取用）
header = struct.pack("<HHH", 0, 1, len(images))
entries = bytearray()
body = bytearray()
offset = 6 + 16 * len(images)
for im in images:
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    png = buf.getvalue()
    w, h = im.size
    entries += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(png), offset)
    body += png
    offset += len(png)

with open(OUT, "wb") as f:
    f.write(header + entries + body)

print("saved", OUT, "frames:", len(images))
