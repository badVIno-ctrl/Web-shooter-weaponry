/* ============================================================================
   FINISH — процедурные покрытия для меша без UV.

   Геометрия оружия здесь генерируется кодом и приходит «супом» треугольников:
   развёртки нет, и делать её ради текстуры нечем. Поэтому покрытие считается
   прямо во фрагментном шейдере по позиции в объектном пространстве, трипланарно.
   Ни текстур, ни файлов — как и весь остальной репозиторий.

   Зачем это вообще: до этой правки берёзовая ламинированная фанера АК была
   ровным оранжевым цветом [0.33, 0.13, 0.046], магазин — ровным розовым, а
   парковка ствольной коробки — ровным серым. Ровный цвет на изогнутой
   поверхности читается как пластик: у настоящего дерева видно слои шпона,
   у парковки — крап и разброс шероховатости, у бакелита — стеклонаполненные
   завихрения. Разница между «моделью» и «предметом» в основном здесь.

   Каждое покрытие модулирует три вещи: цвет, шероховатость и нормаль.
   Модуляции нормали хватает, чтобы поймать блик на волокне дерева и на
   штампованной стали, и она не требует ни tangent-space, ни второго UV.
   ========================================================================== */

(function (root) {
  'use strict';

  /* ---- общий пролог: хеш-шум и трипланарная выборка -------------------- */
  const NOISE = `
  /* Хеш Хоскинса. Здесь сначала стоял классический
       p = fract(p*0.3183099 + k); p *= 17.0;
       return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
     и он давал произведение до ~2.5e5, на котором fract теряет мантиссу.
     Распределение выходило двумодальным, и все десять покрытий читались как
     «соль с перцем» кубиками, а не как материал. Дело было не в муаре. */
  float fHash(vec3 p){
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float fNoise(vec3 x){
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(fHash(i + vec3(0,0,0)), fHash(i + vec3(1,0,0)), f.x),
                   mix(fHash(i + vec3(0,1,0)), fHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(fHash(i + vec3(0,0,1)), fHash(i + vec3(1,0,1)), f.x),
                   mix(fHash(i + vec3(0,1,1)), fHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  /* Полосовой фильтр по экранной производной.

     Частоты ниже взяты из размеров настоящей детали: крап фосфатирования
     порядка 0,4 мм, слой шпона 1,6 мм. Физически это верно, но на экране
     деталь 0,4 мм может занимать меньше пикселя, и тогда шум идёт муаром —
     первая версия давала «соль с перцем» вместо материала на всех десяти
     покрытиях. Поэтому каждая октава гасится, когда её период становится
     меньше пиксельного следа, и вырождается в 0.5, то есть в нейтральное
     значение, а не в случайное. Это обычная фильтрация процедурной текстуры,
     и без неё физически правильный масштаб выглядит хуже, чем неправильный.

     Порог 0.12..0.34 выбран по замеру, а не наугад: при 0.30..0.80 октава с
     клеткой около трёх пикселей проходила почти без ослабления, и вместе с
     возмущением нормали это давало искрящуюся «соль с перцем» на всех
     покрытиях. Клетке нужно не меньше восьми пикселей, иначе её место —
     в шероховатости, а не в геометрии. */
  /* Тот же фильтр для периодических членов. Полосы шпона и торцы кожаных
     шайб считались через fract() и smoothstep(), то есть мимо fFbm, и фильтр
     октав их просто не видел: слой 1,6 мм на экране занимал два-три пикселя
     и бился с волокном в диагональную сетку, похожую на плетение. Здесь
     возвращается вес полосы: 1 — видно, 0 — надо схлопнуть в средний тон. */
  float fBandFade(float coord){
    float px = max(abs(dFdx(coord)), abs(dFdy(coord)));
    return 1.0 - smoothstep(0.12, 0.34, px);
  }
  float fFbm(vec3 p, int oct){
    float px = max(length(dFdx(p)), length(dFdy(p)));
    float a = 0.5, s = 0.0, tot = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= oct) break;
      float w = 1.0 - smoothstep(0.12, 0.34, px);
      s += a * (w * fNoise(p) + (1.0 - w) * 0.5);
      tot += a;
      p *= 2.02; a *= 0.5; px *= 2.02;
    }
    return s / max(tot, 1e-4);
  }
  `;

  /* ---- покрытия --------------------------------------------------------
     vFinishPos — позиция в объектном пространстве, в метрах. Все периоды
     ниже заданы в метрах и взяты из размеров настоящей детали, а не подобраны
     «на глаз»: слой шпона АК — 1,6 мм, крап парковки — порядка 0,4 мм.       */

  const FINISH = {

    /* Берёзовая ламинированная фанера (АК-74, АКМ, СВД).
       Настоящее ложе — это склеенные слои шпона толщиной около 1,6 мм,
       и на боковой поверхности они видны полосами. Плюс волокно вдоль
       детали и потемнение лака в углублениях. */
    birch: `
      float ply = vFinishPos.y / 0.0016;
      float plyFade = fBandFade(ply);
      float plyBand = fract(ply);
      float plyIdx  = floor(ply);
      // каждый слой шпона чуть своего оттенка: шпон резали с разных мест
      float plyTint = mix(0.5, fHash(vec3(plyIdx * 0.37, 3.1, 7.7)), plyFade);
      // клеевой шов между слоями — тёмная тонкая линия
      float seam = mix(1.0, smoothstep(0.0, 0.10, plyBand) * smoothstep(1.0, 0.90, plyBand), plyFade);
      /* Волокно вдоль детали. Частоты подобраны по осям, а не изотропно:
         ложе точат из фанеры так, что волокно идёт вдоль оружия, то есть по Z,
         поэтому по Z частота самая низкая. Частота по Y снята с 120 до 34 —
         на 120 она била с шагом шпона 1,6 мм и давала муар. */
      float grain = fFbm(vec3(vFinishPos.x * 30.0, vFinishPos.y * 34.0, vFinishPos.z * 6.0), 4);
      /* Крупные пятна тона, размером порядка 90 мм. Это единственный член,
         который остаётся виден, когда всё оружие влезает в кадр: слой шпона
         1,6 мм на таком масштабе занимает два пикселя и правильно гасится
         фильтром, а без крупного пятна дерево читается как ровный пластик. */
      float blotch = fFbm(vec3(vFinishPos.x * 11.0, vFinishPos.y * 12.0, vFinishPos.z * 3.2), 3);
      float fleck = fFbm(vec3(vFinishPos * 260.0), 2);
      vec3 lo = vec3(0.038, 0.0135, 0.0050);
      vec3 hi = vec3(0.232, 0.104, 0.0425);
      float t = clamp(0.22 + 0.40 * grain + 0.30 * blotch + 0.12 * plyTint, 0.0, 1.0);
      vec3 col = mix(lo, hi, t);
      col *= mix(0.86, 1.0, seam);
      col *= 1.0 - 0.026 * fleck;
      /* Делим на середину собственного поля, а не на скопированную вручную
         константу. С зашитыми делителями покрытие поднимало берёзу в
         1.5-1.8 раза и уводило оттенок, то есть цвет из палитры перестал быть
         тем цветом, который виден. */
      finishColor *= col / mix(lo, hi, 0.63);
      finishRough += 0.070 * (1.0 - grain) - 0.030 * blotch;
      finishBump   = (grain - 0.5) * 3.4 + (seam - 0.5) * 2.0;  // волокно и шов
    `,

    /* Бакелит АГ-4С — магазины 5,45. Не «розовый»: тёмный сливово-бурый
       с завихрениями стеклонаполнителя и полуглянцевой плёнкой. */
    bakelite: `
      float sw = fFbm(vec3(vFinishPos.x * 34.0, vFinishPos.y * 13.0, vFinishPos.z * 15.0), 4);
      float fib = fFbm(vec3(vFinishPos * 190.0), 3);
      /* Завихрения стеклонаполнителя. АГ-4С — прессованная масса, и разброс
         тона у неё крупный, порядка 30 мм, поэтому он остаётся виден, когда
         магазин занимает в кадре сто пикселей. */
      vec3 lo = vec3(0.038, 0.0125, 0.0085);
      vec3 hi = vec3(0.118, 0.043, 0.0295);
      vec3 col = mix(lo, hi, clamp(0.30 + 0.58 * sw, 0.0, 1.0));
      col *= 1.0 - 0.032 * fib;
      finishColor *= col / mix(lo, hi, 0.59);
      finishRough += 0.032 * fib - 0.022 * sw;
      finishBump   = (sw - 0.5) * 1.6;
    `,

    /* Фосфатирование (парковка). Матовое, с крапом: именно разброс
       шероховатости, а не цвета, делает его похожим на металл. */
    parkerized: `
      float m  = fFbm(vec3(vFinishPos * 780.0), 3);
      float m2 = fFbm(vec3(vFinishPos * 190.0), 3);
      finishColor *= 0.968 + 0.055 * m2 - 0.022 * m;
      finishRough += 0.115 * m - 0.052 * m2;
      finishBump   = (m2 - 0.5) * 2.0;   // фосфат: около 40 мкм
    `,

    /* Оксидирование (воронение). Гладкое, тёмное, с лёгкой «шагренью»
       от полировки перед травлением. */
    blued: `
      float m = fFbm(vec3(vFinishPos * 520.0), 3);
      float p = fFbm(vec3(vFinishPos * 150.0), 2);
      finishColor *= 0.976 + 0.048 * p;
      finishRough += 0.060 * m - 0.028 * p;
      finishBump   = (p - 0.5) * 1.2;    // оксидировано: почти гладко
    `,

    /* Штампованный листовой металл 1 мм: у него есть след прокатки и
       мелкие вмятины от штампа, иначе плоскости читаются как CAD. */
    stamped: `
      float roll = fFbm(vec3(vFinishPos.x * 340.0, vFinishPos.y * 34.0, vFinishPos.z * 34.0), 3);
      float dent = fFbm(vec3(vFinishPos * 110.0), 3);
      float m    = fFbm(vec3(vFinishPos * 700.0), 2);
      finishColor *= 0.964 + 0.070 * dent - 0.024 * m;
      finishRough += 0.100 * m - 0.045 * dent;
      finishBump   = (dent - 0.5) * 3.0 + (roll - 0.5) * 1.1;  // вмятины штампа
    `,

    /* Полимер (M416, SCAR, Glock): матовый, с мелкой «песчаной» фактурой
       от литейной формы. */
    polymer: `
      float g = fFbm(vec3(vFinishPos * 900.0), 3);
      float w = fFbm(vec3(vFinishPos * 130.0), 3);
      finishColor *= 0.980 + 0.032 * w - 0.013 * g;
      finishRough += 0.080 * g - 0.036 * w;
      finishBump   = (w - 0.5) * 2.2;    // фактура литейной формы
    `,

    /* Анодированный алюминий (верхний ресивер M416, SCAR): ровнее полимера,
       со следом экструзии вдоль детали. */
    anodized: `
      float ex = fFbm(vec3(vFinishPos.x * 26.0, vFinishPos.y * 320.0, vFinishPos.z * 320.0), 3);
      float m  = fFbm(vec3(vFinishPos * 620.0), 2);
      finishColor *= 0.983 + 0.027 * ex - 0.010 * m;
      finishRough += 0.072 * m - 0.030 * ex;
      finishBump   = (ex - 0.5) * 1.4;   // след экструзии
    `,

    /* Порошковая краска FDE (SCAR-H). Матовая, чуть неровная по толщине. */
    cerakote: `
      float t = fFbm(vec3(vFinishPos * 150.0), 3);
      float g = fFbm(vec3(vFinishPos * 820.0), 2);
      finishColor *= 0.977 + 0.038 * t - 0.012 * g;
      finishRough += 0.030 * g - 0.014 * t;
      finishBump   = (t - 0.5) * 2.4;    // разнотолщинность краски
    `,

    /* Наборная кожа (рукоять Ka-Bar): шайбы кожи 2,4 мм, торцом наружу. */
    leather: `
      float w = vFinishPos.z / 0.0024;
      float wFade = fBandFade(w);
      float band = fract(w);
      float idx = floor(w);
      float tint = mix(0.5, fHash(vec3(idx * 0.51, 1.7, 9.3)), wFade);
      float seam = mix(1.0, smoothstep(0.0, 0.16, band) * smoothstep(1.0, 0.84, band), wFade);
      float pore = fFbm(vec3(vFinishPos * 430.0), 3);
      vec3 lo = vec3(0.028, 0.0155, 0.0092);
      vec3 hi = vec3(0.084, 0.048, 0.028);
      vec3 col = mix(lo, hi, clamp(0.40 + 0.30 * tint + 0.16 * pore, 0.0, 1.0));
      col *= mix(0.86, 1.0, seam);
      finishColor *= col / mix(lo, hi, 0.58);
      finishRough += 0.070 * pore - 0.024 * seam;
      finishBump   = (seam - 0.5) * 6.0 + (pore - 0.5) * 2.0;  // шайбы кожи
    `,

    /* Латунная гильза: тянутая, со следом матрицы по кругу. */
    brassCase: `
      float d = fFbm(vec3(vFinishPos.x * 260.0, vFinishPos.y * 260.0, vFinishPos.z * 50.0), 3);
      finishColor *= 0.985 + 0.027 * d;
      finishRough += 0.022 * d;
      finishBump   = (d - 0.5) * 1.0;
    `,
  };

  /* Глубина микрорельефа каждого покрытия, метры. */
  const DEPTH = {
    birch: 1.5e-4,       // волокно берёзы, поднятое лаком
    bakelite: 3.0e-5,    // прессованный бакелит, почти гладкий
    parkerized: 4.0e-5,  // фосфатное покрытие
    blued: 1.2e-5,       // оксидирование по полированному
    stamped: 6.0e-5,     // штамповка листа 1 мм
    polymer: 3.5e-5,     // фактура литейной формы
    anodized: 2.0e-5,
    cerakote: 3.0e-5,
    leather: 2.6e-4,     // торцы кожаных шайб
    brassCase: 1.0e-5,
  };

  /* Патч материала. Работает с MeshStandardMaterial и MeshPhysicalMaterial. */
  function applyFinish(mat, kind, opt) {
    const body = FINISH[kind];
    if (!body || !mat) return mat;
    opt = opt || {};
    const strength = opt.strength === undefined ? 1 : opt.strength;
    /* Глубина микрорельефа в МЕТРАХ. Это не косметический множитель.

       Сначала finishBump был безразмерным, а код возмущения нормали трактовал
       его как высоту в метрах: при поле 0.013 на детали 6,7 мм возмущение
       нормали выходило величиной 1.9 при единичной нормали. На матовом
       пластике это почти не видно, а на металле с шероховатостью 0.28
       отражение среды резкое, и оно множило ошибку — все металлические
       покрытия читались как мятая фольга, и снижение коэффициентов втрое
       ничего не меняло, потому что причина была не в них.

       40 мкм для фосфатирования и 150 мкм для волокна дерева — это
       настоящие величины. */
    const bump = opt.bump === undefined ? DEPTH[kind] || 4e-5 : opt.bump;
    const scale = opt.scale === undefined ? 1 : opt.scale;

    mat.userData.finish = kind;
    mat.customProgramCacheKey = () => 'finish:' + kind + ':' + strength + ':' + bump + ':' + scale;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFinishK = { value: strength };
      shader.uniforms.uFinishB = { value: bump };
      shader.uniforms.uFinishS = { value: scale };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFinishPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFinishPos = position;');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nvarying vec3 vFinishPos;\nuniform float uFinishK;\nuniform float uFinishB;\nuniform float uFinishS;\n' + NOISE)
        /* Вклиниваемся сразу после того, как собран diffuseColor, но до
           расчёта освещения, и правим цвет, шероховатость и нормаль. */
        .replace('#include <roughnessmap_fragment>', `
          #include <roughnessmap_fragment>
          {
            vec3 vFinishPosS = vFinishPos * uFinishS;
            #define vFinishPos vFinishPosS
            vec3  finishColor = vec3(1.0);
            float finishRough = 0.0;
            float finishBump  = 0.0;
            ${body}
            #undef vFinishPos
            diffuseColor.rgb *= mix(vec3(1.0), finishColor, uFinishK);
            roughnessFactor = clamp(roughnessFactor + finishRough * uFinishK, 0.03, 1.0);
            vFinishBump = finishBump * uFinishB * uFinishK;
          }
        `)
        .replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          {
            /* Возмущение нормали из скалярного поля: берём его градиент
               численно по экранным производным. Тангенциального базиса для
               этого не нужно, что важно — развёртки у этой геометрии нет. */
            vec3 dpdx = dFdx(-vViewPosition);
            vec3 dpdy = dFdy(-vViewPosition);
            float dbx = dFdx(vFinishBump);
            float dby = dFdy(vFinishBump);
            vec3 r1 = cross(dpdy, normal);
            vec3 r2 = cross(normal, dpdx);
            float det = dot(dpdx, r1);
            vec3 grad = sign(det) * (dbx * r1 + dby * r2);
            normal = normalize(abs(det) * normal - grad);
          }
        `)
        .replace('#include <clipping_planes_pars_fragment>',
          '#include <clipping_planes_pars_fragment>\nfloat vFinishBump = 0.0;');
    };
    mat.needsUpdate = true;
    return mat;
  }

  root.WeaponFinish = { apply: applyFinish, kinds: Object.keys(FINISH) };
})(typeof self !== 'undefined' ? self : this);
