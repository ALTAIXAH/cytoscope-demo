/* Цитоскоп — админка врача: просмотр .svs, находки ИИ, проверка и разметка. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const SVGNS = "http://www.w3.org/2000/svg";
  const PER_PAGE = 12;

  // демо-режим (статическая страница без сервера): см. static/demo.js
  const DEMO = window.CYTO_DEMO || null;
  const st = {
    slides: [], slide: null, classes: [], cmap: {}, findings: [], byId: new Map(),
    active: null, page: 0, sel: null, tool: "pan", showBoxes: true, poll: null,
    ruler: null, draft: null,
  };

  // ---------- API ----------
  async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    return r.json();
  }
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("ru-RU"));
  const clsOf = (f) => f.doctor_cls || f.cls;
  const color = (c) => (st.cmap[c] || st.cmap.OTHER || { color: "#999" }).color;
  const label = (c) => (st.cmap[c] || { label: c }).label;
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ---------- просмотрщик ----------
  const viewer = OpenSeadragon({
    element: $("#osd"),
    drawer: "canvas",
    showNavigationControl: false,
    showNavigator: true,
    navigatorPosition: "BOTTOM_LEFT",
    navigatorSizeRatio: 0.17,
    navigatorAutoFade: false,
    maxZoomPixelRatio: 2.2,
    minZoomImageRatio: 0.7,
    visibilityRatio: 0.4,
    zoomPerScroll: 1.35,
    animationTime: 0.55,
    springStiffness: 9,
    imageLoaderLimit: 8,
    timeout: 60000,
    crossOriginPolicy: false,
    gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
    background: "#0c0f13",
  });

  // SVG-слой поверх снимка в координатах уровня 0
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "overlay");
  const gRoot = document.createElementNS(SVGNS, "g");
  const gBoxes = document.createElementNS(SVGNS, "g");
  const gTools = document.createElementNS(SVGNS, "g");
  gRoot.append(gBoxes, gTools);
  svg.appendChild(gRoot);
  viewer.canvas.appendChild(svg);
  const rlabel = document.createElement("div");
  rlabel.className = "rlabel"; rlabel.hidden = true;
  viewer.canvas.appendChild(rlabel);

  function imgZoom() {
    const it = viewer.world.getItemAt(0);
    return it ? it.viewportToImageZoom(viewer.viewport.getZoom(true)) : 1;
  }
  function syncOverlay() {
    const it = viewer.world.getItemAt(0);
    if (!it) return;
    const p0 = it.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const p1 = it.imageToViewerElementCoordinates(new OpenSeadragon.Point(1000, 0));
    const s = (p1.x - p0.x) / 1000;
    gRoot.setAttribute("transform", `translate(${p0.x},${p0.y}) scale(${s})`);
    if (st.ruler) placeRulerLabel();
    updateReadout();
  }
  viewer.addHandler("update-viewport", syncOverlay);
  viewer.addHandler("animation", syncOverlay);
  viewer.addHandler("resize", syncOverlay);

  // увеличение «как в микроскопе»: увеличение скана × пикселей экрана на пиксель снимка
  const PRESETS = [["Весь", 0], [2, 2], [5, 5], [10, 10], [20, 20], [40, 40]];
  const zb = $("#zoombar");
  PRESETS.forEach(([t, m]) => {
    const b = document.createElement("button");
    b.textContent = m ? `${t}×` : t; b.dataset.m = m;
    b.title = m ? `Увеличение ${m}×` : "Весь снимок (F)";
    b.onclick = () => setMag(m);
    zb.appendChild(b);
  });
  function scanMag() { return (st.slide && st.slide.mag) || 20; }
  function setMag(m) {
    const it = viewer.world.getItemAt(0);
    if (!it) return;
    if (!m) { viewer.viewport.goHome(); return; }
    const z = it.imageToViewportZoom(m / scanMag());
    viewer.viewport.zoomTo(z, viewer.viewport.getCenter(), false);
  }
  function updateReadout() {
    if (!st.slide) return;
    const mag = imgZoom() * scanMag();
    $("#readout").innerHTML = `<b>${mag >= 10 ? mag.toFixed(0) : mag.toFixed(1)}×</b>`;
    zb.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.m && Math.abs(+b.dataset.m - mag) / mag < 0.06));
    // линейка масштаба
    const mpp = st.slide.mpp || 0.5;
    const umPerPx = mpp / imgZoom();
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let um = nice[0];
    for (const n of nice) { if (n / umPerPx <= 140) um = n; }
    const px = um / umPerPx;
    const sb = $("#scalebar");
    sb.querySelector("i").style.width = px + "px";
    sb.querySelector("span").textContent = um >= 1000 ? `${um / 1000} мм` : `${um} мкм`;
  }

  // ---------- рамки ----------
  function boxEl(f) {
    const g = document.createElementNS(SVGNS, "g");
    g.dataset.id = f.id;
    const h = document.createElementNS(SVGNS, "rect");
    h.setAttribute("class", "halo");
    const r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("class", "box");
    for (const el of [h, r]) {
      el.setAttribute("x", f.x); el.setAttribute("y", f.y);
      el.setAttribute("width", f.w); el.setAttribute("height", f.h);
      el.setAttribute("rx", Math.min(f.w, f.h) * 0.08);
    }
    g.append(h, r);
    const t = document.createElementNS(SVGNS, "title");
    g.appendChild(t);
    return g;
  }
  function styleBox(g, f) {
    const c = clsOf(f);
    g.setAttribute("class", `f ${f.status} ${f.source}` + ((st.active && st.active !== c) || vlmRej(f) ? " dim" : "") + (st.sel === f.id ? " sel" : ""));
    g.querySelector("rect.box").setAttribute("stroke", color(c));
    g.querySelector("title").textContent = `${label(c)} · ${Math.round(f.score * 100)}%` + (f.status === "confirmed" ? " · подтверждено" : "");
  }
  function drawBoxes() {
    gBoxes.textContent = "";
    if (!st.showBoxes) return;
    // сначала тусклые, затем активный класс сверху
    const list = [...st.findings].sort((a, b) => (clsOf(a) === st.active) - (clsOf(b) === st.active));
    for (const f of list) {
      const g = boxEl(f);
      styleBox(g, f);
      gBoxes.appendChild(g);
    }
  }
  function restyle(id) {
    const g = gBoxes.querySelector(`g[data-id="${id}"]`);
    const f = st.byId.get(id);
    if (g && f) styleBox(g, f);
  }
  gBoxes.addEventListener("click", (e) => {
    const g = e.target.closest("g.f");
    if (!g || st.tool !== "pan") return;
    e.stopPropagation();
    select(+g.dataset.id, true);
  });
  // клик по рамке не должен двигать снимок
  new OpenSeadragon.MouseTracker({ element: svg, clickHandler: () => {} });

  // ---------- выбор находки ----------
  const vlmRej = (f) => !!(f.features && f.features.vlm && f.features.vlm.rejected && f.status === "pending");
  function listForTab() {
    const L = st.findings.filter((f) => !st.active || clsOf(f) === st.active);
    const w = (f) => (f.status === "rejected" ? 2 : vlmRej(f) ? 1 : 0);
    return L.sort((a, b) => w(a) - w(b) || (b.source === "doctor") - (a.source === "doctor") || b.score - a.score);
  }
  function select(id, zoom) {
    const prev = st.sel;
    st.sel = id;
    if (prev) restyle(prev);
    restyle(id);
    const f = st.byId.get(id);
    if (!f) return;
    // страница галереи, где лежит находка
    const L = listForTab();
    const i = L.findIndex((x) => x.id === id);
    if (i < 0 && st.active) { st.active = null; renderTabs(); drawBoxes(); return select(id, zoom); }
    st.page = Math.floor(Math.max(i, 0) / PER_PAGE);
    renderGallery();
    renderDetail();
    if (zoom) zoomTo(f);
    history.replaceState(null, "", `#${encodeURIComponent(st.slide.id)}/${id}`);
  }
  function zoomTo(f) {
    const it = viewer.world.getItemAt(0);
    if (!it) return;
    // показать клетку примерно при 20× (или больше, если клетка мелкая)
    const want = (20 / scanMag());
    const vw = viewer.container.clientWidth, vh = viewer.container.clientHeight;
    const side = Math.max(f.w, f.h);
    const zImg = Math.min(want, Math.min(vw, vh) / (side * 2.2));
    const wImg = vw / zImg, hImg = vh / zImg;
    const rect = it.imageToViewportRectangle(f.x + f.w / 2 - wImg / 2, f.y + f.h / 2 - hImg / 2, wImg, hImg);
    viewer.viewport.fitBounds(rect, false);
  }
  // порядок обхода: как в галерее, но без переноса отклонённых в конец
  function navList() {
    return st.findings.filter((f) => !st.active || clsOf(f) === st.active)
      .sort((a, b) => (b.source === "doctor") - (a.source === "doctor") || b.score - a.score);
  }
  function step(d, onlyPending) {
    const all = navList();
    if (!all.length) return;
    let i = all.findIndex((f) => f.id === st.sel);
    for (let n = 0; n < all.length; n++) {
      i = i < 0 ? (d > 0 ? 0 : all.length - 1) : (i + d + all.length) % all.length;
      const f = all[i];
      if (f.status === "rejected") continue;
      if (onlyPending && f.status !== "pending") continue;
      return select(f.id, true);
    }
  }

  // ---------- проверка ----------
  async function review(id, body) {
    const f = st.byId.get(id);
    if (!f) return;
    try {
      const nf = await api(`api/findings/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      Object.assign(f, nf);
      restyle(id); renderTabs(); renderGallery(); renderDetail(); renderFoot();
    } catch (e) { toast("Не сохранилось: " + e.message); }
  }
  async function removeFinding(id) {
    try {
      await api(`api/findings/${id}`, { method: "DELETE" });
      st.findings = st.findings.filter((f) => f.id !== id); st.byId.delete(id);
      st.sel = null; drawBoxes(); renderTabs(); renderGallery(); renderDetail(); renderFoot();
    } catch (e) { toast(e.message); }
  }

  // ---------- панель ----------
  function renderAI() {
    const s = st.slide && st.slide.summary;
    const cat = $("#aiCat"), note = $("#aiNote"), dl = $("#aiStats");
    if (!st.slide) { cat.textContent = "—"; note.textContent = ""; dl.innerHTML = ""; return; }
    if (!s) {
      cat.innerHTML = `<span class="muted" style="font-size:15px;font-weight:500">Анализ ещё не запускался</span>`;
      note.textContent = "Нажмите «Анализ ИИ» — программа найдёт и разметит подозрительные клетки.";
      dl.innerHTML = ""; return;
    }
    const c = s.category === "NILM" ? "#3ccf8e" : color(s.category);
    const inf = s.infections || {};
    const extra = [inf.trich_suspected && "трихомонады", inf.bv_suspected && "бактериальный вагиноз (ключевые клетки)"].filter(Boolean);
    const head = s.category === "NILM" ? (extra.length ? "NILM" : s.category_label) : s.category_label;
    cat.innerHTML = `<span class="dot" style="background:${c}"></span><span>${head}${extra.length ? `<br><span style="font-size:15px;font-weight:500">+ ${extra.join(" + ")}</span>` : ""}</span>`;
    note.textContent = s.disclaimer;
    const rows = [
      ["Плоский эпителий", fmt(s.squamous_cells) + (s.adequacy === "достаточно" ? " · достаточно" : " · мало")],
      ["Лейкоциты", fmt(s.leukocytes) + ` · воспаление: ${s.inflammation}`],
    ];
    const more = [
      ["Норма ядра на стекле", `${s.ref_nucleus_um2} мкм²`],
      ["Модель", `${s.model} · ${s.elapsed_s} с`],
    ];
    if (inf.model) {
      rows.push(["Ключевые клетки", `${inf.clue_confirmed} из ${inf.clue_checked} (${Math.round((inf.clue_rate || 0) * 100)}%)`]);
      rows.push(["Трихомонады", `${inf.trich_confirmed} кандидатов врачу`]);
      more.push(["Проверка инфекций", inf.model + " · по трихомонадам ненадёжна"]);
    }
    if (s.vlm_verify) more.push(["Второе мнение", `${s.vlm_verify.model}: отсеяно ${s.vlm_verify.rejected} из ${s.vlm_verify.checked}`]);
    if (s.classifier_cv) {
      more.push(["Клеток оценено моделью", fmt(s.candidates)]);
      more.push(["Качество на открытых данных", `AUC ${s.classifier_cv.auc_abnormal} · на ваших стёклах не проверено`]);
    }
    const kv = (L) => L.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
    dl.innerHTML = kv(rows) + `<details class="ai-more"><summary>Подробнее</summary><dl class="ai-stats">${kv(more)}</dl></details>`;
  }
  function counts() {
    const m = {};
    for (const f of st.findings) if (f.status !== "rejected") m[clsOf(f)] = (m[clsOf(f)] || 0) + 1;
    return m;
  }
  function renderTabs() {
    const m = counts();
    const total = Object.values(m).reduce((a, b) => a + b, 0);
    const el = $("#tabs");
    el.innerHTML = "";
    const mk = (code, text, n, c) => {
      const b = document.createElement("button");
      b.className = "tab" + (st.active === code ? " on" : "");
      b.setAttribute("role", "tab");
      if (c) b.style.setProperty("--tc", c);
      b.innerHTML = (c ? `<span class="dot" style="background:${c}"></span>` : "") + `${text} <b>${fmt(n)}</b>`;
      b.onclick = () => { st.active = code; st.page = 0; renderTabs(); drawBoxes(); renderGallery(); };
      el.appendChild(b);
    };
    mk(null, "Все", total, null);
    st.classes.filter((c) => m[c.code]).sort((a, b) => b.rank - a.rank).forEach((c) => mk(c.code, c.label, m[c.code], c.color));
  }
  function cropUrl(f, s = 192) {
    if (DEMO) return f.id > 0 ? `${DEMO.base}crops/${f.id}.jpg` : DEMO.blank;
    return `api/slides/${encodeURIComponent(st.slide.id)}/crop?x=${f.x.toFixed(0)}&y=${f.y.toFixed(0)}&w=${f.w.toFixed(0)}&h=${f.h.toFixed(0)}&s=${s}`;
  }
  function renderGallery() {
    const L = listForTab();
    const pages = Math.max(1, Math.ceil(L.length / PER_PAGE));
    st.page = Math.min(st.page, pages - 1);
    const el = $("#gallery");
    el.innerHTML = "";
    if (!L.length) {
      el.innerHTML = `<div class="none">${st.slide && st.slide.summary ? "Находок нет." : "Здесь появятся клетки, которые нашла программа."}</div>`;
    }
    for (const f of L.slice(st.page * PER_PAGE, (st.page + 1) * PER_PAGE)) {
      const b = document.createElement("button");
      b.className = `cell ${f.status} ${f.source}` + (vlmRej(f) ? " vlmrej" : "") + (st.sel === f.id ? " sel" : "");
      const mark = f.source === "doctor" ? "врач" : f.status === "confirmed" ? "✓" : f.status === "rejected" ? "✕" : vlmRej(f) ? "?" : "";
      b.innerHTML = `<img loading="lazy" src="${cropUrl(f)}" alt=""><span class="bar" style="background:${color(clsOf(f))}"></span>` +
        (mark ? `<span class="st">${mark}</span>` : "") + (f.source === "ai" ? `<span class="sc">${Math.round(f.score * 100)}</span>` : "");
      b.title = `${label(clsOf(f))}` + (f.features && f.features.why ? ` — ${f.features.why}` : "");
      b.onclick = () => select(f.id, true);
      el.appendChild(b);
    }
    const pg = $("#pager");
    pg.innerHTML = "";
    if (pages > 1) {
      const btn = (t, p, dis) => { const b = document.createElement("button"); b.textContent = t; b.disabled = dis; b.onclick = () => { st.page = p; renderGallery(); }; pg.appendChild(b); };
      btn("‹", st.page - 1, st.page === 0);
      const s = document.createElement("span"); s.textContent = `${st.page + 1} из ${pages}`; pg.appendChild(s);
      btn("›", st.page + 1, st.page >= pages - 1);
    }
  }
  function renderDetail() {
    const el = $("#detail");
    const f = st.sel && st.byId.get(st.sel);
    if (!f) { el.hidden = true; return; }
    el.hidden = false;
    const c = clsOf(f);
    const changed = f.doctor_cls && f.doctor_cls !== f.cls;
    const state = f.status === "confirmed" ? `подтверждено${f.reviewer ? " · " + f.reviewer : ""}` : f.status === "rejected" ? "отклонено" : "не проверено";
    el.innerHTML = `
      <img src="${cropUrl(f, 224)}" alt="">
      <div>
        <div class="d-cls"><span class="dot" style="background:${color(c)}"></span>${label(c)}
          ${f.source === "ai" ? `<span class="muted" style="font-weight:400;font-size:12px">ИИ ${Math.round(f.score * 100)}%${changed ? " · было " + label(f.cls) : ""}</span>` : `<span class="muted" style="font-weight:400;font-size:12px">рамка врача</span>`}
        </div>
        <div class="d-why">${f.features && f.features.why ? f.features.why : ""}</div>
        <div class="d-acts">
          <button class="yes" data-a="ok" title="A">Подтвердить</button>
          <button class="no" data-a="no" title="X">Отклонить</button>
          <button data-a="cls" title="1–9">Класс…</button>
          ${f.source === "doctor" ? `<button data-a="del">Удалить</button>` : ""}
        </div>
        <div class="d-state">${state}</div>
      </div>`;
    el.querySelector('[data-a="ok"]').onclick = () => review(f.id, { status: "confirmed" });
    el.querySelector('[data-a="no"]').onclick = () => review(f.id, { status: "rejected" });
    el.querySelector('[data-a="cls"]').onclick = (e) => openClassMenu(e.target.getBoundingClientRect(), (code) => review(f.id, { cls: code }));
    const del = el.querySelector('[data-a="del"]');
    if (del) del.onclick = () => removeFinding(f.id);
  }
  function renderFoot() {
    const s = st.slide && st.slide.summary;
    $("#cellCount").textContent = s ? fmt(s.squamous_cells) : "—";
    const ai = st.findings.filter((f) => f.source === "ai");
    const done = ai.filter((f) => f.status !== "pending").length;
    const doc = st.findings.filter((f) => f.source === "doctor").length;
    $("#reviewCount").textContent = `${fmt(done)} из ${fmt(ai.length)}` + (doc ? ` · своих ${doc}` : "");
  }

  // ---------- меню классов ----------
  function openClassMenu(rect, cb) {
    const m = $("#classMenu");
    m.innerHTML = "";
    st.classes.forEach((c, i) => {
      const b = document.createElement("button");
      b.innerHTML = `<span class="dot" style="background:${c.color}"></span>${c.label}` + (i < 9 ? `<kbd>${i + 1}</kbd>` : "");
      b.onclick = () => { closeMenu(); cb(c.code); };
      m.appendChild(b);
    });
    m.hidden = false;
    const x = Math.min(rect.left, innerWidth - 210), y = Math.min(rect.bottom + 4, innerHeight - m.offsetHeight - 8);
    m.style.left = x + "px"; m.style.top = y + "px";
    m._cb = cb;
  }
  function closeMenu() { const m = $("#classMenu"); m.hidden = true; m._cb = null; }
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#classMenu")) { const m = $("#classMenu"); if (!m.hidden) { closeMenu(); clearDraft(); } } });

  // ---------- инструменты ----------
  function setTool(t) {
    st.tool = t;
    document.querySelectorAll(".tool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    $("#osd").className = "osd tool-" + t;
    viewer.setMouseNavEnabled(t === "pan");
    viewer.panHorizontal = viewer.panVertical = true;
    const hint = $("#toolHint");
    hint.hidden = t === "pan";
    hint.textContent = t === "box" ? "Обведите клетку мышью, затем выберите класс. Esc — отмена." : t === "ruler" ? "Протяните линию — покажу длину в микрометрах. Esc — выход." : "";
    if (t !== "ruler") clearRuler();
  }
  document.querySelectorAll(".tool[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $("#btnBoxes").onclick = toggleBoxes;
  function toggleBoxes() { st.showBoxes = !st.showBoxes; $("#btnBoxes").classList.toggle("off", !st.showBoxes); drawBoxes(); }

  function evImg(e) {
    const it = viewer.world.getItemAt(0);
    const rect = viewer.canvas.getBoundingClientRect();
    return it.viewerElementToImageCoordinates(new OpenSeadragon.Point(e.clientX - rect.left, e.clientY - rect.top));
  }
  let drag = null;
  viewer.canvas.addEventListener("pointerdown", (e) => {
    if (st.tool === "pan" || e.button !== 0 || !viewer.world.getItemAt(0)) return;
    drag = { a: evImg(e) };
    viewer.canvas.setPointerCapture(e.pointerId);
    if (st.tool === "box") {
      clearDraft();
      st.draft = document.createElementNS(SVGNS, "rect");
      st.draft.setAttribute("class", "draft");
      gTools.appendChild(st.draft);
    } else if (st.tool === "ruler") {
      clearRuler();
      st.ruler = { a: drag.a, b: drag.a, g: document.createElementNS(SVGNS, "g") };
      st.ruler.g.setAttribute("class", "ruler");
      st.ruler.g.innerHTML = `<line class="h"/><line/><circle r="4"/><circle r="4"/>`;
      gTools.appendChild(st.ruler.g);
    }
    e.preventDefault();
  });
  viewer.canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const b = evImg(e);
    if (st.tool === "box" && st.draft) {
      const x = Math.min(drag.a.x, b.x), y = Math.min(drag.a.y, b.y);
      st.draft.setAttribute("x", x); st.draft.setAttribute("y", y);
      st.draft.setAttribute("width", Math.abs(b.x - drag.a.x)); st.draft.setAttribute("height", Math.abs(b.y - drag.a.y));
    } else if (st.tool === "ruler" && st.ruler) {
      st.ruler.b = b; drawRuler();
    }
  });
  viewer.canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const b = evImg(e), a = drag.a;
    drag = null;
    if (st.tool === "box" && st.draft) {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      if (w < 6 || h < 6) { clearDraft(); return; }
      openClassMenu({ left: e.clientX, bottom: e.clientY }, async (code) => {
        try {
          const f = await api(`api/slides/${encodeURIComponent(st.slide.id)}/findings`, { method: "POST", body: JSON.stringify({ x, y, w, h, cls: code }) });
          st.findings.push(f); st.byId.set(f.id, f);
          clearDraft(); drawBoxes(); renderTabs(); renderFoot(); select(f.id, false);
        } catch (err) { toast(err.message); clearDraft(); }
      });
    }
  });
  function clearDraft() { if (st.draft) st.draft.remove(); st.draft = null; }
  function drawRuler() {
    const { a, b, g } = st.ruler;
    g.querySelectorAll("line").forEach((l) => { l.setAttribute("x1", a.x); l.setAttribute("y1", a.y); l.setAttribute("x2", b.x); l.setAttribute("y2", b.y); });
    const [c1, c2] = g.querySelectorAll("circle");
    const r = 4 / Math.max(imgZoom(), 1e-6);
    c1.setAttribute("cx", a.x); c1.setAttribute("cy", a.y); c1.setAttribute("r", r);
    c2.setAttribute("cx", b.x); c2.setAttribute("cy", b.y); c2.setAttribute("r", r);
    placeRulerLabel();
  }
  function placeRulerLabel() {
    const { a, b } = st.ruler;
    const it = viewer.world.getItemAt(0);
    const um = Math.hypot(b.x - a.x, b.y - a.y) * (st.slide.mpp || 0.5);
    const p = it.imageToViewerElementCoordinates(new OpenSeadragon.Point((a.x + b.x) / 2, (a.y + b.y) / 2));
    rlabel.hidden = um < 0.5;
    rlabel.textContent = um >= 1000 ? `${(um / 1000).toFixed(2)} мм` : `${um.toFixed(1)} мкм`;
    rlabel.style.left = p.x + "px"; rlabel.style.top = p.y + "px";
    const [c1, c2] = st.ruler.g.querySelectorAll("circle");
    const r = 4 / Math.max(imgZoom(), 1e-6);
    c1.setAttribute("r", r); c2.setAttribute("r", r);
  }
  function clearRuler() { if (st.ruler) st.ruler.g.remove(); st.ruler = null; rlabel.hidden = true; }

  // ---------- снимок экрана ----------
  $("#btnShot").onclick = screenshot;
  function screenshot() {
    const src = viewer.drawer.canvas;
    if (!src || !st.slide) return;
    const dpr = src.width / viewer.container.clientWidth;
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    const x = c.getContext("2d");
    x.fillStyle = "#0c0f13"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(src, 0, 0);
    const it = viewer.world.getItemAt(0);
    if (st.showBoxes) {
      for (const f of st.findings) {
        if (f.status === "rejected") continue;
        const p = it.imageToViewerElementCoordinates(new OpenSeadragon.Point(f.x, f.y));
        const q = it.imageToViewerElementCoordinates(new OpenSeadragon.Point(f.x + f.w, f.y + f.h));
        if (q.x < 0 || q.y < 0 || p.x > viewer.container.clientWidth || p.y > viewer.container.clientHeight) continue;
        x.lineWidth = 4 * dpr; x.strokeStyle = "rgba(0,0,0,.55)";
        x.strokeRect(p.x * dpr, p.y * dpr, (q.x - p.x) * dpr, (q.y - p.y) * dpr);
        x.lineWidth = 2 * dpr; x.strokeStyle = color(clsOf(f));
        x.setLineDash(f.source === "doctor" ? [6 * dpr, 3 * dpr] : []);
        x.strokeRect(p.x * dpr, p.y * dpr, (q.x - p.x) * dpr, (q.y - p.y) * dpr);
        x.setLineDash([]);
      }
    }
    if (st.ruler) {
      const a = it.imageToViewerElementCoordinates(new OpenSeadragon.Point(st.ruler.a.x, st.ruler.a.y));
      const b = it.imageToViewerElementCoordinates(new OpenSeadragon.Point(st.ruler.b.x, st.ruler.b.y));
      x.strokeStyle = "#fff"; x.lineWidth = 2.5 * dpr;
      x.beginPath(); x.moveTo(a.x * dpr, a.y * dpr); x.lineTo(b.x * dpr, b.y * dpr); x.stroke();
      x.font = `${13 * dpr}px sans-serif`; x.fillStyle = "#fff";
      x.fillText(rlabel.textContent, ((a.x + b.x) / 2 + 8) * dpr, ((a.y + b.y) / 2 - 8) * dpr);
    }
    // подпись: снимок, увеличение, масштаб, предупреждение
    const mag = imgZoom() * scanMag();
    const umPerPx = (st.slide.mpp || 0.5) / imgZoom();
    const barUm = [10, 20, 50, 100, 200, 500, 1000].filter((n) => n / umPerPx < 160).pop() || 10;
    const pad = 12 * dpr, hBar = 54 * dpr;
    x.fillStyle = "rgba(12,15,19,.82)";
    x.fillRect(0, c.height - hBar, c.width, hBar);
    x.fillStyle = "#e6eaef"; x.font = `600 ${14 * dpr}px sans-serif`;
    x.fillText(`${st.slide.barcode || st.slide.id} · ${mag.toFixed(mag >= 10 ? 0 : 1)}× · ${new Date().toLocaleString("ru-RU")}`, pad, c.height - hBar + 22 * dpr);
    x.font = `${12 * dpr}px sans-serif`; x.fillStyle = "#8d98a5";
    x.fillText("Разметка программы — предварительная, не является диагнозом", pad, c.height - hBar + 42 * dpr);
    const bx = c.width - pad - (barUm / umPerPx) * dpr, by = c.height - hBar + 30 * dpr;
    x.strokeStyle = "#e6eaef"; x.lineWidth = 2 * dpr;
    x.beginPath(); x.moveTo(bx, by - 5 * dpr); x.lineTo(bx, by); x.lineTo(c.width - pad, by); x.lineTo(c.width - pad, by - 5 * dpr); x.stroke();
    x.fillStyle = "#e6eaef"; x.textAlign = "right";
    x.fillText(barUm >= 1000 ? `${barUm / 1000} мм` : `${barUm} мкм`, c.width - pad, by - 9 * dpr);
    c.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${st.slide.id}_${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
  }

  // ---------- загрузка снимка ----------
  async function loadSlides() {
    st.slides = await api("api/slides");
    const sel = $("#slideSelect");
    sel.innerHTML = st.slides.map((s) => `<option value="${s.id}">${s.barcode ? s.barcode + " · " : ""}${s.id}</option>`).join("");
    $("#empty").hidden = st.slides.length > 0;
  }
  $("#slideSelect").onchange = (e) => openSlide(e.target.value);

  async function openSlide(id, focusId) {
    st.slide = await api(`api/slides/${encodeURIComponent(id)}`);
    $("#slideSelect").value = id;
    st.sel = null; st.active = null; st.page = 0; clearRuler(); clearDraft();
    const s = st.slide;
    $("#slideMeta").innerHTML = `${s.barcode ? `Штрихкод <b>${s.barcode}</b> · ` : ""}${fmt(s.width)}×${fmt(s.height)} пкс · ${s.mag || "?"}× · ${s.mpp ? s.mpp.toFixed(3) + " мкм/пкс" : ""}`;
    if (DEMO) {
      $("#btnExport").removeAttribute("href");
      $("#btnExport").onclick = () => DEMO.exportJson(st.slide, st.findings);
    } else $("#btnExport").href = `api/slides/${encodeURIComponent(id)}/export`;
    const lc = $("#labelCard");
    if (s.associated.includes("label") || s.associated.includes("macro")) {
      const nm = s.associated.includes("label") ? "label" : "macro";
      $("#labelImg").src = `api/slides/${encodeURIComponent(id)}/image/${nm}`;
      $("#labelCap").textContent = s.barcode || "этикетка";
      lc.hidden = false;
      lc.onclick = () => { $("#labelBigImg").src = `api/slides/${encodeURIComponent(id)}/image/macro`; $("#labelBig").showModal(); };
    } else lc.hidden = true;
    viewer.open(DEMO ? `${DEMO.base}${id}.dzi` : `dzi/${encodeURIComponent(id)}.dzi`);
    viewer.addOnceHandler("open", () => { syncOverlay(); if (focusId && st.byId.get(focusId)) select(focusId, true); });
    await loadFindings();
    renderAI(); renderJob();
    if (!focusId || !st.byId.get(focusId)) history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    else if (viewer.world.getItemAt(0)) select(focusId, true);
  }
  async function loadFindings() {
    st.findings = await api(`api/slides/${encodeURIComponent(st.slide.id)}/findings`);
    st.byId = new Map(st.findings.map((f) => [f.id, f]));
    drawBoxes(); renderTabs(); renderGallery(); renderDetail(); renderFoot();
  }

  // ---------- анализ ----------
  if (DEMO) {
    $("#btnAnalyze").hidden = true;
    $("#upload").closest("label").hidden = true;
  }
  $("#btnAnalyze").onclick = async () => {
    if (!st.slide || DEMO) return;
    if (st.findings.some((f) => f.status !== "pending") && !confirm("Перезапустить анализ? Проверенные вами находки и ваши рамки сохранятся, непроверенные находки ИИ будут заменены.")) return;
    await api(`api/slides/${encodeURIComponent(st.slide.id)}/analyze`, { method: "POST" });
    st.slide.status = "queued"; st.slide.progress = 0; st.slide.stage = "в очереди";
    renderJob();
  };
  function renderJob() {
    const s = st.slide;
    const busy = s && (s.status === "queued" || s.status === "running");
    $("#job").hidden = !busy && !(s && s.status === "error");
    $("#btnAnalyze").disabled = !!busy;
    $("#btnAnalyze").textContent = s && s.summary ? "Перезапустить анализ" : "Анализ ИИ";
    if (s && s.status === "error") { $("#jobText").textContent = "ошибка анализа"; $("#jobBar").style.width = "0"; $("#job").title = s.error || ""; }
    if (busy) {
      $("#jobBar").style.width = Math.round((s.progress || 0) * 100) + "%";
      $("#jobText").textContent = s.stage || "…";
      clearTimeout(st.poll);
      st.poll = setTimeout(pollJob, 1500);
    }
  }
  async function pollJob() {
    if (!st.slide) return;
    const id = st.slide.id;
    const s = await api(`api/slides/${encodeURIComponent(id)}`);
    if (!st.slide || st.slide.id !== id) return;
    const was = st.slide.status;
    st.slide = s;
    renderJob();
    if (was !== "done" && s.status === "done") { await loadFindings(); renderAI(); toast("Анализ готов"); }
  }

  // ---------- загрузка снимка ----------
  $("#upload").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "api/upload");
    $("#job").hidden = false;
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      $("#jobBar").style.width = Math.round((ev.loaded / ev.total) * 100) + "%";
      $("#jobText").textContent = `загрузка ${fmt(Math.round(ev.loaded / 1048576))} из ${fmt(Math.round(ev.total / 1048576))} МБ`;
    };
    xhr.onload = async () => {
      e.target.value = "";
      if (xhr.status !== 200) { toast("Не загрузилось: " + xhr.responseText); renderJob(); return; }
      const { id } = JSON.parse(xhr.responseText);
      await loadSlides();
      await openSlide(id);
    };
    xhr.onerror = () => { toast("Ошибка сети при загрузке"); renderJob(); };
    xhr.send(fd);
  };

  // ---------- клавиатура ----------
  document.addEventListener("keydown", (e) => {
    if ((e.target.matches && e.target.matches("input, select, textarea")) || e.metaKey || e.ctrlKey || e.altKey) return;
    const m = $("#classMenu");
    if (!m.hidden && /^[1-9]$/.test(e.key)) { const c = st.classes[+e.key - 1]; if (c && m._cb) { const cb = m._cb; closeMenu(); cb(c.code); } return; }
    const k = e.key.toLowerCase();
    if (k === "escape") { closeMenu(); clearDraft(); setTool("pan"); return; }
    if (k === "v" || k === "м") setTool("pan");
    else if (k === "b" || k === "и") setTool("box");
    else if (k === "r" || k === "к") setTool(st.tool === "ruler" ? "pan" : "ruler");
    else if (k === "h" || k === "р") toggleBoxes();
    else if (k === "f" || k === "а") viewer.viewport.goHome();
    else if (k === "s" || k === "ы") screenshot();
    else if (k === "?") $("#help").showModal();
    else if (k === "arrowright") { step(1); e.preventDefault(); }
    else if (k === "arrowleft") { step(-1); e.preventDefault(); }
    else if (st.sel) {
      if (k === "a" || k === "ф" || k === "enter") review(st.sel, { status: "confirmed" }).then(() => step(1, true));
      else if (k === "x" || k === "ч" || k === "delete" || k === "backspace") review(st.sel, { status: "rejected" }).then(() => step(1, true));
      else if (k === "u" || k === "г") review(st.sel, { status: "pending" });
      else if (/^[1-9]$/.test(k)) { const c = st.classes[+k - 1]; if (c) review(st.sel, { cls: c.code }); }
    }
  });
  $("#btnHelp").onclick = () => $("#help").showModal();

  // ---------- старт ----------
  (async () => {
    st.classes = await api("api/classes");
    st.cmap = Object.fromEntries(st.classes.map((c) => [c.code, c]));
    await loadSlides();
    const [hid, hf] = decodeURIComponent(location.hash.slice(1)).split("/");
    const first = st.slides.find((s) => s.id === hid) || st.slides[0];
    if (first) await openSlide(first.id, hf ? +hf : null);
  })().catch((e) => toast("Ошибка загрузки: " + e.message));
})();
