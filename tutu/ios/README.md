# Tutu для iOS

SwiftUI-застосунок: LiDAR-сканування тіла → завантаження на сервер → вбудований редактор.

## Збірка

```bash
brew install xcodegen
cd tutu/ios
xcodegen            # створює Tutu.xcodeproj з project.yml
open Tutu.xcodeproj
```

Вкажіть свою команду (Signing & Capabilities) і запустіть на iPhone/iPad **з LiDAR**
(12 Pro і новіші Pro, iPad Pro 2020+). У симуляторі ARKit не працює.

## Як працює сканування

1. `BodyScanner` запускає `ARWorldTrackingConfiguration` з `sceneReconstruction = .meshWithClassification`.
2. Користувач наводить приціл на людину → «Це людина» (raycast фіксує центр).
3. Сканує, обходячи людину по колу (людина стоїть нерухомо, руки трохи від тіла).
4. `MeshExporter` об'єднує `ARMeshAnchor` у світових координатах (метри), викидає
   підлогу/стіни/меблі за класифікацією LiDAR, обрізає циліндром навколо людини,
   зварює шви між шматками і пише OBJ.
5. OBJ завантажується на сервер (`POST /api/scans`), відкривається редактор
   (`WKWebView` → `/?scan=<id>`). Експорт трафарету з редактора приходить
   через `window.webkit.messageHandlers.tutu` і відкривається в Share Sheet.

У налаштуваннях на головному екрані вкажіть адресу сервера, напр. `http://192.168.1.20:8000`
(комп'ютер і телефон — в одній мережі).
