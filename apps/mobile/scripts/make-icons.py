"""生成 KKChat 图标与启动图。品牌色与网页一致：深蓝 #1e3a5f、橙 #c2410c，暖白底 #f3eee4。

    python3 scripts/make-icons.py

只依赖 Pillow 和系统自带的 Noto Sans Bold。输出覆盖 assets/ 下的同名文件。
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent / "assets"
NAVY = (30, 58, 95)
ORANGE = (194, 65, 12)
CREAM = (243, 238, 228)
FONT = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"


def conic(size: int) -> Image.Image:
    """深蓝 → 橙 → 深蓝 的锥形渐变，对应网页上的 KK 标志。"""
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    center = size / 2
    for y in range(size):
        for x in range(size):
            angle = (math.degrees(math.atan2(y - center, x - center)) + 360 + 60) % 360 / 360
            mix = 1 - abs(angle - 0.5) * 2
            pixels[x, y] = tuple(int(NAVY[i] + (ORANGE[i] - NAVY[i]) * mix) for i in range(3))
    return image


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_mark(image: Image.Image, box: int, offset: tuple[int, int], color=(255, 255, 255)):
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(FONT, int(box * 0.42))
    text = "KK"
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    width, height = right - left, bottom - top
    draw.text((offset[0] + (box - width) / 2 - left, offset[1] + (box - height) / 2 - top), text, font=font, fill=color)


def main():
    size = 1024
    icon = conic(size)
    draw_mark(icon, size, (0, 0))
    framed = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    framed.paste(icon, (0, 0), rounded_mask(size, 220))
    framed.save(ROOT / "icon.png")

    background = conic(size)
    background.save(ROOT / "android-icon-background.png")

    foreground = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_mark(foreground, int(size * 0.62), (int(size * 0.19), int(size * 0.19)))
    foreground.save(ROOT / "android-icon-foreground.png")

    mono = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_mark(mono, int(size * 0.62), (int(size * 0.19), int(size * 0.19)), color=(255, 255, 255))
    mono.save(ROOT / "android-icon-monochrome.png")

    splash = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mark = conic(int(size * 0.5))
    draw_mark(mark, int(size * 0.5), (0, 0))
    splash.paste(mark, (int(size * 0.25), int(size * 0.25)), rounded_mask(int(size * 0.5), 110))
    splash.save(ROOT / "splash-icon.png")

    fav = framed.resize((96, 96), Image.LANCZOS)
    fav.save(ROOT / "favicon.png")


if __name__ == "__main__":
    main()
