"""Ten realistic adult body types. Values are MakeHuman-style macro parameters
(0..1, 0.5 = population average) plus height in centimetres."""
from __future__ import annotations

BODY_PRESETS: list[dict] = [
    {"id": "m-slim", "label": "Худорлявий", "description": "низька вага, вузька кістка",
     "params": {"sex": 1.0, "height_cm": 180, "weight": 0.15, "muscle": 0.45}},
    {"id": "m-average", "label": "Середній", "description": "середні зріст і статура",
     "params": {"sex": 1.0, "height_cm": 176, "weight": 0.5, "muscle": 0.5}},
    {"id": "m-athletic", "label": "Атлетичний", "description": "розвинені м'язи, мало жиру",
     "params": {"sex": 1.0, "height_cm": 181, "weight": 0.55, "muscle": 0.9}},
    {"id": "m-stocky", "label": "Кремезний", "description": "широкий, сильний, з запасом",
     "params": {"sex": 1.0, "height_cm": 172, "weight": 0.8, "muscle": 0.75}},
    {"id": "m-heavy", "label": "Повний", "description": "велика вага, м'який живіт",
     "params": {"sex": 1.0, "height_cm": 175, "weight": 1.0, "muscle": 0.35}},
    {"id": "f-slim", "label": "Струнка", "description": "низька вага, тонка кістка",
     "params": {"sex": 0.0, "height_cm": 170, "weight": 0.15, "muscle": 0.45, "breast": 0.4}},
    {"id": "f-average", "label": "Середня", "description": "середні зріст і статура",
     "params": {"sex": 0.0, "height_cm": 164, "weight": 0.5, "muscle": 0.5, "breast": 0.5}},
    {"id": "f-athletic", "label": "Спортивна", "description": "тонус, сильні ноги",
     "params": {"sex": 0.0, "height_cm": 168, "weight": 0.45, "muscle": 0.85, "breast": 0.4, "glutes": 0.3}},
    {"id": "f-curvy", "label": "Пишна", "description": "виражені груди і стегна",
     "params": {"sex": 0.0, "height_cm": 165, "weight": 0.7, "muscle": 0.5, "breast": 0.85, "glutes": 0.6}},
    {"id": "f-plus", "label": "Повна", "description": "велика вага",
     "params": {"sex": 0.0, "height_cm": 162, "weight": 1.0, "muscle": 0.35, "breast": 0.8, "glutes": 0.3}},
]


def find_preset(preset_id: str) -> dict | None:
    return next((p for p in BODY_PRESETS if p["id"] == preset_id), None)
