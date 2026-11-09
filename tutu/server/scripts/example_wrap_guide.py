import json, re
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
I = json.load(open('/tmp/claude-0/e2e/info-wrap.json'))
W, H = I['size']['width'], I['size']['height']
D = '/tmp/claude-0/dragon/'
X1, Y1 = 820, 664                       # area of the canvas used by the body
S = 1024/X1                             # guide pixels per unit
GW, GH = 1024, int(round(Y1*S/64))*64
g = Image.new('RGB', (GW, GH), 'white')
def paste(img, box, mask):
    x0, y0, x1, y1 = [int(v*S) for v in box]
    img = img.resize((x1-x0, y1-y0), Image.LANCZOS); m = mask.resize((x1-x0, y1-y0), Image.LANCZOS)
    g.paste(img, (x0, y0), m)
# portrait on the back (oval mask)
face = Image.open(D+'v3-back-0.webp').convert('RGB')
w, h = face.size; yy, xx = np.mgrid[0:h, 0:w]
r = np.hypot((xx/w-0.5)/0.5, (yy/h-0.42)/0.52); m = Image.fromarray((np.clip((1-r)/0.3, 0, 1)*255).astype(np.uint8))
paste(face, (30, 0, 380, 600), m)
# dragon body: from the back of the head over the right shoulder, down around the hair
body = [(585, 470), (560, 560), (490, 600), (410, 575), (365, 490), (362, 370), (370, 250), (350, 130), (300, 50), (220, 18), (130, 25), (60, 70)]
d = ImageDraw.Draw(g)
pts = [(x*S, y*S) for x, y in body]
for wdt, col in [(70, (25, 18, 16)), (46, (70, 40, 28)), (14, (230, 120, 40))]:
    d.line(pts, fill=col, width=int(wdt*S*0.7), joint='curve')
# dragon head on the chest
head = Image.open(D+'v3-chest-1.webp').convert('RGB')
a = np.asarray(head.convert('L')); ys, xs = np.where(a < 235)
head = head.crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1))
hm = Image.fromarray(((np.asarray(head.convert('L')) < 238)*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))
hw = 250; hh = hw*head.height/head.width
paste(head, (448, 36, 448+hw, 36+hh), hm)
g.save('/tmp/claude-0/wrap/guide.png')
# preview with the body outline
p = g.copy(); dp = ImageDraw.Draw(p)
for sg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', sg)))
    dp.line([(x*S, y*S) for x, y in zip(nums[0::2], nums[1::2])] + [(nums[0]*S, nums[1]*S)], fill=(160, 160, 160), width=2)
p.save('/tmp/claude-0/wrap/guide-preview.png'); print(GW, GH)
