"""r07 guide: one_dragon_around_torso with fixes from r06 analysis."""
import copy
import sys
sys.path.insert(0, r"C:\tutu\1234\tutu")
import numpy as np
from PIL import Image
from comfy_nodes import core

L = copy.deepcopy(core.LAYOUTS["one_dragon_around_torso"])
# r06: the pale "light on the cheek" ellipse turned into a white disc / crescent over the eye -> drop it
L["ellipses"] = [e for e in L["ellipses"] if e[1] != (200, 150, 130)]
# r06: the tail started at the jaws (600, 345) and was read as a tongue / rope out of the mouth ->
# start it from the lower part of the coil, away from the head
paths = [p for p in L["paths"] if p[1] != 30]
paths.append(([(690, 505), (720, 580), (715, 650), (690, 717)], 30, (45, 30, 30)))
L["paths"] = paths
core.LAYOUTS["r07"] = L
c = core.load_canvas("wrap_torso", 1024)
g = core.layout_guide(c, "r07", "white", 4)
Image.fromarray((g * 255).astype(np.uint8)).save(sys.argv[1])
print("saved", sys.argv[1])
