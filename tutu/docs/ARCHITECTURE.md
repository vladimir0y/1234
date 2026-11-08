# Tutu — архітектура і захист коду

Документ описує, як має виглядати продакшн-система Tutu: що де працює, які
сервіси потрібні, як захищені код і дані користувачів, і в якому порядку все
будувати.

---

## 1. Захист коду: що зробити, щоб ні в кого не було доступу

### 1.1 Негайно (сьогодні)

| # | Дія | Навіщо |
|---|---|---|
| 1 | **Зробити репозиторій приватним**: GitHub → `vladimir0y/1234` → Settings → General → Danger Zone → *Change visibility* → Private | Зараз репозиторій **публічний**: код бачить будь-хто |
| 2 | Створити окрему **GitHub Organization** (напр. `tutu-app`) і **новий приватний** репозиторій `tutu` лише з папкою `tutu/` (`git subtree split --prefix=tutu -b tutu-only` → push у новий репо) | Не змішувати продукт зі старою грою; права керуються на рівні організації |
| 3 | Увімкнути **2FA обов'язково** для всіх учасників організації | Найчастіший шлях витоку — зламаний акаунт |
| 4 | **Branch protection** на `main`: тільки через PR, ≥1 рев'ю, зелений CI, заборона force-push і видалення | Ніхто не може тихо змінити або стерти код |
| 5 | Увімкнути **Secret scanning + Push protection**, **Dependabot** | Ключі не потраплять у git; вразливі залежності помітні |
| 6 | Ліцензія **«All rights reserved»** (файл `LICENSE` додано) | Юридично: копіювати й використовувати код без дозволу заборонено |

> Секретів (API-ключів, паролів) у коді немає: ключ OpenAI читається лише зі
> змінної середовища. Тому публічний період не відкрив жодних ключів, але
> сам код міг бути переглянутий або скопійований. Скасувати це вже не можна;
> далі важливо, щоб цінна частина жила на сервері (див. 1.3).

### 1.2 Правила доступу

- **Мінімальні права.** Розробник отримує доступ лише до потрібного репозиторію
  (наприклад, iOS-підрядник — тільки `tutu-ios`). Ролі: Owner — 1–2 людини,
  решта — Write без адмінських прав.
- **NDA + договір про передачу прав на код** з кожним підрядником ще до видачі доступу.
- **Відкликання доступу** в день завершення співпраці; щоквартальний аудит учасників
  (Settings → People) і deploy-ключів.
- **Секрети** — тільки в GitHub Actions Secrets і менеджері секретів хмари
  (Doppler / AWS Secrets Manager). `.env` у `.gitignore` (вже налаштовано).
- **Підписані коміти** (SSH/GPG) для `main`, щоб не можна було підробити автора.
- **Audit log** організації (GitHub Enterprise або щотижневий експорт) — видно, хто що клонував.

### 1.3 Код, який бачать користувачі (технічний захист)

Важливо чесно розуміти межу: **JavaScript у браузері і бінарник iOS завжди можна
розібрати.** Тому мета — щоб копія клієнта без нашого сервера нічого не вартувала.

1. **Цінні алгоритми — на сервер.** Клієнт лише показує результат:
   - ✅ генерація базових тіл уже на сервері (браузер отримує лише готовий меш);
   - LSCM-розгортка і розрізання швів;
   - промпти і стильові пресети генерації, постобробка ескізів у трафарет;
   - обробка сканів (чистка, ремеш, SMPL-X).
   Розгортка поки працює в браузері; її перенесення — фаза 1 (розділ 8).
2. **Продакшн-збірка без source maps**, мініфікація; критичні модулі додатково
   обфускуються (`javascript-obfuscator`). iOS: release-збірка зі `strip`, без
   debug-символів у бінарнику (dSYM — лише в Sentry/Crashlytics).
3. **API закрите авторизацією**: кожен запит з токеном користувача, ліміти
   запитів (rate limit), захист від ботів (Cloudflare Turnstile на вебі,
   **App Attest** на iOS), файли — лише через тимчасові підписані посилання.
4. **Юридичний захист**: торгова марка «Tutu», умови використання з
   забороною реверс-інжинірингу, ліцензія `LICENSE`.

---

## 2. Загальна схема

```
                    ┌──────────────────────── Клієнти ────────────────────────┐
                    │  Web (TS + Three.js)     iOS (SwiftUI)     Android (пізніше)
                    │  редактор, кабінет       базові тіла,      
                    │                          LiDAR (додатково), 
                    │                          редактор у WebView
                    └────────────┬─────────────────────────────────────────────┘
                                 │ HTTPS
                    ┌────────────▼────────────┐
                    │ Cloudflare              │  CDN для вебу, WAF, DDoS,
                    │                         │  Turnstile, кеш статики
                    └────────────┬────────────┘
                                 │
        ┌────────────────────────▼────────────────────────┐
        │ API (FastAPI, Docker, stateless, 2+ інстанси)    │
        │ auth · projects · bodies · scans · generate ·    │
        │ billing · share · artists                        │
        └───┬──────────────┬──────────────┬───────────────┘
            │              │              │ ставить задачі
   ┌────────▼───┐   ┌──────▼──────┐  ┌────▼─────────────────────────────┐
   │ PostgreSQL │   │ Redis       │  │ Workers (Python, черга Arq)       │
   │ дані,      │   │ черга,      │  │  generate_sketch → OpenAI/Flux    │
   │ проєкти    │   │ ліміти, кеш │  │  build_body / unwrap              │
   └────────────┘   └─────────────┘  │  process_scan (Open3D, PyMeshLab) │
                                     │  fit_body (GPU, SMPL-X)           │
   ┌──────────────────────────────┐  │  render_preview                   │
   │ Object storage (R2 / S3)     │◄─┤                                   │
   │ скани, ескізи, трафарети,    │  └──────────┬───────────────────────┘
   │ меші тіл. Приватні, шифровані│             │ GPU за запитом
   └──────────────────────────────┘     ┌───────▼────────┐
                                        │ Modal / RunPod │
   Зовнішні: OpenAI Images, Replicate,  └────────────────┘
   Stripe, App Store + RevenueCat, Sentry, PostHog, Resend (email)
```

### Чому так

- **API без стану** → масштабується додаванням інстансів.
- **Довгі операції — у черзі** (генерація 10–40 с, обробка скану хвилини):
  API відповідає одразу `job_id`, клієнт отримує результат через polling або WebSocket.
- **Один редактор для вебу й iOS** (WebView) → функції пишуться один раз.
  Нативне в iOS лише те, що вимагає заліза: камера/LiDAR, покупки, поширення файлів.

---

## 3. Компоненти і технології

| Шар | Технологія | Примітка |
|---|---|---|
| Веб-клієнт | TypeScript, Three.js, Vite; далі — Preact/React для кабінету | Редактор уже є |
| iOS | SwiftUI, ARKit (LiDAR, опційно), WKWebView, StoreKit 2 | Мін. iOS 17 |
| API | Python 3.12, FastAPI, Pydantic, SQLAlchemy 2 + Alembic | Каркас уже є |
| Черга | Redis + Arq (async-воркери) | Простіше за Celery |
| БД | PostgreSQL 16 (Neon / Supabase / RDS) | Бекапи щодня, PITR 7 днів |
| Файли | Cloudflare R2 (без плати за трафік) або S3 | Шифрування SSE, приватні бакети |
| Генерація | OpenAI `gpt-image-1` (основний), Flux через Replicate (резерв) | Абстракція провайдера вже є |
| 3D-обробка | Open3D, PyMeshLab, trimesh | Очищення і ремеш сканів |
| Тіла | ✅ Параметрична модель на основі MakeHuman (ресурси CC0, комерційно дозволено), генерація на сервері (numpy, Catmull–Clark). Далі — підгонка під заміри/фото | SMPL-X — лише з комерційною ліцензією (Meshcapade); MakeHuman її не потребує |
| GPU | Modal або RunPod serverless | Платимо лише за секунди роботи |
| Auth | Sign in with Apple, Google, email magic link; JWT 15 хв + refresh | Можна взяти Clerk/Supabase Auth |
| Платежі | Stripe (веб), StoreKit 2 (iOS), RevenueCat — єдиний статус підписки | Apple вимагає IAP для цифрових товарів в iOS |
| Моніторинг | Sentry (помилки), OpenTelemetry → Grafana Cloud, PostHog (аналітика, EU) | |
| Пошта | Resend / Postmark | |

---

## 4. Модель даних (PostgreSQL)

```
users            id, email, name, role(user|artist|admin), locale, created_at, deleted_at
auth_identities  id, user_id, provider(apple|google|email), subject
bodies           id, user_id, kind(preset|scan|fitted), preset_id, params jsonb,
                 mesh_key (R2), triangles, created_at
scans            id, user_id, source(lidar|upload), raw_key, cleaned_key, status, created_at
projects         id, user_id, body_id, name, thumbnail_key, created_at, updated_at
project_versions id, project_id, state jsonb (виділення, шари, трансформи), created_at
assets           id, user_id, kind(sketch|upload|ink|stencil), key, width, height, bytes
generations      id, user_id, project_id, prompt, style, provider, status, cost_cents,
                 asset_id, moderation jsonb, created_at
subscriptions    id, user_id, plan(free|plus|pro), source(stripe|appstore), status, renews_at
usage_counters   user_id, period, generations_used, exports_used
share_links      id, project_id, token, permissions(view|comment), expires_at
artists          id, user_id, studio_id, portfolio jsonb, city, verified
studios          id, name, owner_id, address
bookings         id, project_id, artist_id, status, quote_cents, date
audit_log        id, user_id, action, target, ip, created_at
```

Великі дані (меші, зображення) — лише в R2; у БД — ключ і метадані.
Стан редактора зберігається версіями (`project_versions`), щоб можна було відкотитися.

---

## 5. API v1 (основне)

```
POST /v1/auth/apple | /v1/auth/google | /v1/auth/email      → токени
GET  /v1/me                                                 профіль, план, ліміти

GET  /v1/body-presets                                       10 базових статур
POST /v1/bodies            {preset_id, height, params}      → body (меш генерує сервер)
POST /v1/scans             multipart OBJ/PLY                → job_id (очищення в черзі)
GET  /v1/bodies/{id}/mesh                                   → підписане посилання на меш

POST /v1/projects | GET /v1/projects | GET/PUT/DELETE /v1/projects/{id}
POST /v1/projects/{id}/unwrap      {faces}                  → uv (на сервері)
POST /v1/projects/{id}/share                                → посилання

POST /v1/generate          {prompt, style, project_id, region_mask?} → job_id
GET  /v1/jobs/{id}                                          статус / результат
POST /v1/projects/{id}/stencil     {dpi}                    → PNG/PDF 1:1

POST /v1/billing/checkout  (Stripe)   POST /v1/billing/apple-notify (App Store)
```

Усі ендпоінти: авторизація, перевірка власника ресурсу, rate limit
(напр. 30 генерацій/год на free), валідація розмірів файлів.

---

## 6. Безпека і приватність даних тіла

Скан тіла — чутливі персональні дані. Правила:

- **Шифрування**: TLS скрізь; R2/S3 і Postgres — шифрування на диску.
- **Приватність за замовчуванням**: скани і проєкти бачить лише власник;
  доступ до файлів — посилання, що живуть 5 хвилин.
- **Мінімізація**: зберігаємо меш без текстури шкіри; фото зі сканування
  не завантажуємо, якщо користувач явно не погодився.
- **Видалення**: «Видалити акаунт» прибирає все протягом 30 днів (включно з бекапами);
  експорт своїх даних (GDPR).
- **Дані в ЄС** (регіони EU для БД і файлів).
- **Не тренуємо моделі** на даних користувачів; це прописано в політиці.
- **Модерація** промптів і результатів генерації (заборонений контент, символи ненависті).
- **18+**: підтвердження віку при реєстрації (тематика тату).
- **Анатомічна модель без одягу**: для App Store — рейтинг 17+ і опція «показати білизну»
  на моделі (за замовчуванням увімкнена); тату-майстрам — перемикач на повне тіло.
- Пентест перед публічним релізом; Dependabot і `pip-audit`/`npm audit` у CI.

---

## 7. Середовища, інфраструктура, CI/CD

| Середовище | Де | Що |
|---|---|---|
| dev | Docker Compose локально | api, worker, postgres, redis, minio (S3) |
| staging | та сама хмара, що й prod, менші ресурси | автодеплой з `main` |
| prod | див. нижче | деплой після ручного підтвердження |

**Старт (дешево, швидко):** Fly.io або Render (api + workers), Neon (Postgres),
Upstash (Redis), Cloudflare R2 + Pages (веб), Modal (GPU).
Орієнтовно **$50–150/міс** без урахування генерацій.

**Масштаб:** AWS (ECS Fargate, RDS, ElastiCache, S3, CloudFront), уся
інфраструктура в Terraform.

**CI/CD (GitHub Actions):**
1. PR → лінтери, тести (`pytest`, `vitest`), збірка, `npm audit`/`pip-audit`.
2. Merge у `main` → Docker-образи → staging → smoke-тести.
3. Тег `v*` → prod (з ручним підтвердженням), міграції Alembic.
4. iOS: Xcode Cloud або fastlane → TestFlight → App Store.

**Вартість генерації** — головна змінна витрата (орієнтовно кілька центів за
зображення, залежно від моделі та якості). Тому: ліміти на free, кеш однакових
запитів, дешевша модель для чернеток.

---

## 8. Дорожня карта

| Фаза | Тривалість | Результат |
|---|---|---|
| **0. Захист** | 1–2 дні | Приватний репо в організації, 2FA, branch protection, ліцензія |
| **1. Бекенд-продакшн** | 3–4 тижні | ✅ генерація тіл на сервері, ✅ Docker-образ + CI. Далі: Postgres + R2 + черга; акаунти; розгортка на сервері; staging |
| **2. Монетизація і ШІ** | 3–4 тижні | Stripe/IAP, ліміти; генерація під форму ділянки (inpainting за маскою); шерінг |
| **3. iOS у TestFlight** | 3 тижні | Базові тіла, редактор, покупки; LiDAR — як додаткова функція |
| **4. Якість тіла** | 4–6 тижнів | Налаштування статури повзунками (обхвати), комерційна ліцензія SMPL-X, підгонка за фото |
| **5. Майстри** | 4 тижні | Профілі студій, заявки з проєктом, оцінка вартості |
| **6. Реліз** | 2 тижні | Пентест, політики, App Store review, лендинг |

**Команда для такого темпу:** 1 full-stack (TS + Python), 1 iOS, 1 дизайнер
(частково), за потреби — 3D/ML-інженер на фазу 4.
