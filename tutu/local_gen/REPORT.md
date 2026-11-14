# Локальна генерація: звіт (2026-11-14)

ПК: RTX 3050 Ti Laptop 4 ГБ VRAM, 16 ГБ RAM (вільно ~2 ГБ), ComfyUI 0.45.0 portable, Python 3.13, torch 2.14.1+cu130.

## Моделі в ComfyUI\models
- checkpoints: `DreamShaperXL_Lightning.safetensors` (SDXL, 6.6 ГБ)
- diffusion_models: `z_image_turbo_bf16.safetensors` (12.3 ГБ), text_encoders: `qwen_3_4b.safetensors` (8 ГБ), vae: `ae.safetensors` — Z-Image Turbo
- loras / controlnet / inpaint / upscale / clip_vision — порожні.
- Інших генераторів (A1111, Forge, Fooocus, InvokeAI, Ollama, LM Studio) немає. «Купа функцій» — ~1100 вбудованих вузлів ComfyUI, з них ~339 платні хмарні API-вузли (потрібен акаунт Comfy і кредити).

## Швидкість SDXL, 1024×896, 6 кроків
| Прапорці | холодний | прогрітий |
|---|---|---|
| без прапорців | 485 с | — |
| `--lowvram --fp8_e4m3fn-unet --preview-method none` | 369 с | **293 с** (~40–50 с/крок) |
| `--lowvram --preview-method none` | 518 с | 534 с (*) |

(*) збіглося з копіюванням 19 ГБ на той самий диск, тому трохи завищено. Залишено fp8-варіант у `run_nvidia_gpu.bat` (оригінал — `run_nvidia_gpu.original.bat`). 768×672: 54 с на прогрітій моделі.

## Файли
- `scene-101.png`, `scene-202.png` — завдання 1, 768×672 (329 с / 54 с). Дракона SDXL не намалював — лише портрет.
- `scene-101_1024x896.png` — те саме 1024×896 (485 с): дракон маленький, ліворуч; обличчя по центру. Txt2img SDXL не ставить обличчя ліворуч (сіди 101, 11, 12 — усі по центру).
- `pipeline_1_scene_layout.png`, `pipeline_body_preview.png`, `pipeline_dragon_face_wrap_torso.png` — схема `tutu_dragon_face_pipeline` через API, **852 с** усього, без помилок; вузли Tutu імпортуються за 0.1 с. Розкладка спрацювала: обличчя ліворуч, дракон праворуч. Зауваження: контур тіла в `TutuBodyPreview` зубчастий (маска тіла без згладжування/супердискретизації).
- Рецепт: `recipe_tutu_scene.png` (= перший прохід pipeline), `recipe_tutu_mask.png` (x>430 або y>750, blur 40), `recipe_step3_dragon_101.png` (124 с, кращий: чітка голова з відкритою пащею), `recipe_step3_dragon_202.png` (253 с, голова розмита), `recipe_step4_unified.png` (denoise 0.3, 96 с).
- `zimage_101.png` — **Z-Image Turbo**, 1024×896, 8 кроків, res_multistep, cfg 1, fp8-ваги: 777 с з першим завантаженням моделей. З першої спроби виконав увесь промпт: заплющені очі, дракон обвиває жінку, паща відкрита, дим. Схема — `tutu/worker/comfy/5_zimage_txt2img.json`.

## Рекомендація
Для композиції «за промптом» Z-Image Turbo значно краще за SDXL. Для точного розміщення на полотні тіла — pipeline з вузлами Tutu (розкладка + маска зони). Пам'яті мало: закривати браузер/ігри під час генерації.
