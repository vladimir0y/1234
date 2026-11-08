"""Prompt building for tattoo sketch generation."""
from __future__ import annotations

STYLES: dict[str, str] = {
    "fine-line": "delicate fine line tattoo, single needle, thin precise black lines, minimal shading",
    "blackwork": "bold blackwork tattoo, solid black fills, strong contrast, graphic shapes",
    "traditional": "american traditional tattoo flash, bold outlines, limited palette, classic motifs",
    "geometric": "geometric tattoo, sacred geometry, precise symmetric linework, dotwork accents",
    "watercolor": "watercolor tattoo, soft color washes, paint splashes, loose sketchy outlines",
    "minimal": "minimalist tattoo, very simple, few lines, lots of negative space",
    "japanese": "japanese irezumi tattoo style, flowing composition, waves and wind bars",
    "realism": "black and grey realism tattoo, smooth gradients, high detail",
}

BASE = (
    "tattoo design flash sheet, single isolated design centered, "
    "clean white background, no skin, no body, no mockup, no text, no watermark, "
    "high contrast, print-ready stencil quality"
)


def build_prompt(user_prompt: str, style: str, shape_hint: str | None = None) -> str:
    style_text = STYLES.get(style, STYLES["fine-line"])
    parts = [user_prompt.strip(), style_text]
    if shape_hint:
        parts.append(f"composition fits a {shape_hint} area")
    parts.append(BASE)
    return ", ".join(p for p in parts if p)


def shape_hint_from_aspect(aspect: float | None) -> str | None:
    """aspect = width / height of the unwrapped region."""
    if aspect is None or aspect <= 0:
        return None
    if aspect > 2.2:
        return "long horizontal band"
    if aspect > 1.3:
        return "wide horizontal"
    if aspect < 0.45:
        return "long vertical strip"
    if aspect < 0.77:
        return "tall vertical"
    return "roughly square"
