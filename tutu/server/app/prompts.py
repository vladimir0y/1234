"""Prompt building for tattoo sketch generation."""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Style:
    id: str
    label: str
    prompt: str
    mode: str  # "ink" = black linework on transparent, "color" = keep colours


STYLES_LIST = [
    Style("art", "Художнє зображення", "beautiful original artwork illustration, rich composition, not a generic tattoo flash, no banners", "color"),
    Style("art-bw", "Художнє, чорно-біле", "beautiful original black and grey artwork illustration, confident linework, not a generic tattoo flash", "ink"),
    Style("fine-line", "Fine line", "delicate fine line tattoo, single needle, thin precise black lines, minimal shading", "ink"),
    Style("blackwork", "Blackwork", "bold blackwork tattoo, solid black fills, strong contrast, graphic shapes", "ink"),
    Style("minimal", "Мінімалізм", "minimalist tattoo, very simple, few clean lines, lots of negative space", "ink"),
    Style("geometric", "Геометрія", "geometric tattoo, sacred geometry, precise symmetric linework", "ink"),
    Style("dotwork", "Dotwork", "dotwork tattoo, stippling shading made of tiny dots, black ink", "ink"),
    Style("ornamental", "Орнамент", "ornamental tattoo, mandala and filigree patterns, symmetric decorative linework", "ink"),
    Style("lettering", "Леттеринг", "elegant script lettering tattoo, calligraphy, clean black ink", "ink"),
    Style("tribal", "Трайбл", "tribal tattoo, flowing bold black shapes, polynesian inspired", "ink"),
    Style("sketch", "Скетч", "sketch style tattoo, loose pencil-like lines, artistic hatching", "ink"),
    Style("realism", "Реалізм ч/б", "black and grey realism tattoo, smooth gradients, high detail", "ink"),
    Style("traditional", "Traditional", "american traditional tattoo flash, bold black outlines, limited flat colours", "color"),
    Style("neo-traditional", "Neo-traditional", "neo traditional tattoo, bold outlines, rich colours, ornate details", "color"),
    Style("japanese", "Японський", "japanese irezumi tattoo style, bold outlines, waves and wind bars", "color"),
    Style("watercolor", "Акварель", "watercolor tattoo, soft colour washes, paint splashes, loose outlines", "color"),
]
STYLES = {s.id: s for s in STYLES_LIST}

BASE = (
    "artwork only, single isolated design centered, plain pure white background, "
    "flat 2D artwork, no skin, no body, no mockup, no frame, no watermark, high contrast, stencil-ready"
)
NEGATIVE = "photo, skin, arm, person, mockup, frame, border, text, watermark, signature, blurry, gradient background, 3d render"


def build_prompt(user_prompt: str, style: str, shape_hint: str | None = None) -> str:
    st = STYLES.get(style, STYLES["fine-line"])
    # Start with "illustration on paper": the word "tattoo" alone makes many
    # models draw a tattooed person instead of the design itself.
    parts = [f"flash sheet illustration on white paper of {user_prompt.strip()}", st.prompt]
    if st.mode == "ink":
        parts.append("black ink only, no colour")
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


_CYRILLIC = re.compile(r"[Ѐ-ӿ]")


def needs_translation(text: str) -> bool:
    return bool(_CYRILLIC.search(text))
