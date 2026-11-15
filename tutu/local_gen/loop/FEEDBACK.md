# Правки для циклу генерації

- Раунд 0 (zimage_101, recipe_step4): сцена гарна, але темний фон лягає на тулуб як футболка, обличчя на боці. Потрібно: світлий фон, обличчя в лівій половині, голова дракона в правій, тіло дракона між ними.

## Після раунду 1 (обрано r01_seed202 — 9/10, на тілі виглядає добре)
1. Обличчя трохи правіше хребта: зсунь у підкладці зону обличчя ліворуч на ~30 px (центр обличчя має бути на x≈250 px з 1024).
2. Тіло дракона на правому боці (x≈420–560 px) надто тонке й димне — зроби його товщим і чіткішим (луска), щоб на боці тіла його було видно.
3. Волосся ліворуч обрізане краєм полотна — нехай м'яко розчиняється раніше (x>40 px).
4. Прибрати «вуса» й гриву класичного дракона: у промпт "sleek smooth head, no whiskers, no mane".
Раунд 2: ті самі параметри (denoise 0.8), сіди 202, 303, 404.

## НОВА ЦІЛЬ від власника (замінює попередні правки) — `TARGET_reference.jpg`
Дійти щонайменше до рівня цього референсу:
- **Спина:** обличчя дівчини майже на всю спину (від шиї до попереку, центр на хребті), розпатлане темне волосся, напіввідкриті світлі очі, губи; позаду великий **червоний місяць** угорі ліворуч і **червоні хмари/дим** унизу.
- **Груди:** голова дракона на правому грудному м'язі, паща відкрита до грудини, шия йде вгору через праве плече (далі на руку).
- **Палітра:** чорно-сірий реалізм + **глибокий червоний** акцент. Без помаранчевого.
- **Стиль:** реалістичне тату на шкірі (не картина на папері): тло — чиста шкіра/білий, тонкі деталі, дрібна луска, крапкові тіні.

Як генерувати (Z-Image Turbo, 1024×896):
- Підкладка: вузол «Tutu: розкладка композиції», **preset `reference_red_back_dragon_chest`** (новий, git pull), background white, blur 10. denoise 0.8 (пробуй 0.75–0.9).
- Промпт: "hyperrealistic black and grey tattoo with deep crimson red accents on plain white background, fine detailed tattoo art, stippled shading; on the left a huge face of a beautiful young asian woman fills the whole height, messy dark hair strands across her face, half-open pale eyes, parted lips, freckles, behind her a large red moon and swirling red clouds and smoke; on the right the head of a black dragon with fine scales and red accents roars with open jaws and long fangs facing left, its neck rises up to the top edge; one continuous tattoo design"
- Мета на раунд: 3 сіди. Оцінюй сам за переліком вище; найкращі пуш як r02_…, r03_… у tutu-local-gen.

## Після раунду 3 (r03_seed303 на тілі — спина вже дуже схожа на референс)
1. Місяць обрізаний верхнім краєм (лягає на верх плеча): опусти його нижче й ближче до хребта — центр ~(130, 230) од., радіус ~70 од.
2. Хмари внизу — мультяшні спіралі. Потрібні реалістичні клуби диму/хмар з червоним підсвітленням: "realistic billowing smoke clouds".
3. Обличчя трохи витягнуте вертикально — зроби зону обличчя ширшою/нижчою (≈ 90–330 по x, 170–600 по y).
4. Груди: голова добра, але немає тіла дракона. Шия має бути товстою, лускатою, червоні плавці, іти вгору через праве плече (верхній край на x≈380–470) — як у референсі.
5. Стиль: менше «фото», більше тату — "tattoo ink on skin, fine linework, stippling, black and grey realism tattoo".

## Від власника після раунду 4: дракон НЕ класичний (діє з r06, якщо r05 вже йде — з наступного)
Дракон зараз старомодний (класичний китайський/японський: роги, шипи-гребені, «вуса», ікла як у традиційного тату). Потрібне **модерне переосмислення дракона**:
- гладка обтічна голова, як з полірованого чорного обсидіану / рідкого чорнила; кілька різких графічних площин замість дрібних шипів;
- тіло-шия перетікає в чорнильний дим і тонкі графічні лінії (fine-line, геометричні акценти, мінімалізм); червоне — як тонкі світні лінії/розколи всередині, а не плавці;
- без рогів, без гриви, без вусів, без гребенів, без «хмарок» традиційного стилю.
Промпт для дракона (замінити частину про дракона): "on the right a modern reinterpretation of a dragon: sleek smooth obsidian black dragon head with sharp minimal geometric planes, open jaws facing the centre, its long neck dissolves into flowing black ink smoke and fine-line graphic strokes with thin glowing crimson cracks, rising up over the shoulder to the top edge; contemporary surreal fine-line tattoo style"
Негатив (якщо cfg>1) / уникати у промпті: "traditional chinese dragon, japanese irezumi dragon, horns, whiskers, mane, spiky crest, fins, cartoon".
Решту (обличчя, місяць, дим, пресет) не змінювати. Пробуй 3 сіди.
