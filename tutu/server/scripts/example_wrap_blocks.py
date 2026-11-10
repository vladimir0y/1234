"""Rough colour blocks on the around-the-torso canvas: only WHERE things go, no old images."""
import json, re
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
I = json.load(open('/tmp/claude-0/e2e/info-wrap.json'))
S = 1024/820; GW, GH = 1024, 896
g = Image.new('RGB', (GW, GH), 'white'); d = ImageDraw.Draw(g)
def P(pts): return [(x*S, y*S) for x, y in pts]
# hair mass behind the face (back, centre ~200)
d.ellipse(P([(40, -40), (370, 560)]), fill=(150, 55, 25))
# face oval, lit from the upper left
d.ellipse(P([(110, 60), (300, 400)]), fill=(225, 165, 120))
d.ellipse(P([(120, 70), (230, 260)]), fill=(250, 205, 150))
# dragon body: chest -> belly -> right side -> lower back -> up the left side of the back
body = [(585, 430), (560, 560), (490, 615), (410, 610), (330, 590), (240, 600), (140, 590), (60, 520), (40, 400), (45, 270), (70, 150), (130, 70)]
d.line(P(body), fill=(35, 25, 22), width=int(62*S), joint='curve')
d.line(P(body), fill=(150, 60, 20), width=int(14*S), joint='curve')
# dragon head on the right chest: dark wedge, open jaws, warm glow inside
d.polygon(P([(470, 60), (560, 70), (690, 160), (700, 210), (620, 230), (560, 300), (600, 420), (540, 440), (500, 330), (470, 220)]), fill=(30, 22, 20))
d.polygon(P([(560, 230), (690, 215), (640, 330), (580, 330)]), fill=(240, 120, 30))
d.ellipse(P([(585, 125), (605, 145)]), fill=(255, 150, 40))
g = g.filter(ImageFilter.GaussianBlur(6))
g.save('/tmp/claude-0/wrap3/blocks.png')
p = g.copy(); dp = ImageDraw.Draw(p)
for sg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', sg)))
    dp.line([(x*S, y*S) for x, y in zip(nums[0::2], nums[1::2])] + [(nums[0]*S, nums[1]*S)], fill=(160, 160, 160), width=2)
p.save('/tmp/claude-0/wrap3/blocks-preview.png'); print('ok')
