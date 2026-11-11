/* Демо-режим Цитоскопа для статической страницы (GitHub Pages).
   Подменяет вызовы api/... на файлы demo/*.json; отметки врача хранятся только в браузере. */
(() => {
  "use strict";
  const base = "demo/";
  const KEY = "cytoscope-demo-v1";
  const origFetch = window.fetch.bind(window);
  let data = null;

  async function load() {
    if (data) return data;
    const [classes, slide, findings] = await Promise.all(
      ["classes", "slide", "findings"].map((n) => origFetch(base + n + ".json").then((r) => r.json()))
    );
    let local = {};
    try { local = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { local = {}; }
    local.edits = local.edits || {};
    local.added = local.added || [];
    local.removed = local.removed || [];
    const removed = new Set(local.removed);
    const list = findings
      .filter((f) => !removed.has(f.id))
      .map((f) => (local.edits[f.id] ? Object.assign({}, f, local.edits[f.id]) : f))
      .concat(local.added);
    data = { classes, slide, findings: list, local };
    return data;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data.local)); } catch (e) { /* приватный режим */ }
  }
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const now = () => Date.now() / 1000;

  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const m = url.match(/(?:^|\/)api\/([^?]*)/);
    if (!m) return origFetch(input, init);
    const path = m[1];
    const method = (init.method || "GET").toUpperCase();
    const d = await load();
    let mm;
    if (path === "classes") return json(d.classes);
    if (path === "slides") return json([d.slide]);
    if (/^slides\/[^/]+$/.test(path)) return json(d.slide);
    if (/^slides\/[^/]+\/findings$/.test(path)) {
      if (method === "POST") {
        const b = JSON.parse(init.body || "{}");
        const f = Object.assign({ id: -Date.now(), slide_id: d.slide.id, score: 1, source: "doctor", status: "confirmed",
          doctor_cls: b.cls, reviewer: "демо", created_at: now(), reviewed_at: now(), features: null }, b);
        d.findings.push(f);
        d.local.added.push(f);
        save();
        return json(f);
      }
      return json(d.findings);
    }
    if ((mm = path.match(/^findings\/(-?\d+)$/))) {
      const id = +mm[1];
      const f = d.findings.find((x) => x.id === id);
      if (!f) return json({ detail: "нет такой находки" }, 404);
      if (method === "DELETE") {
        d.findings = d.findings.filter((x) => x.id !== id);
        d.local.added = d.local.added.filter((x) => x.id !== id);
        save();
        return json({ ok: true });
      }
      const b = JSON.parse(init.body || "{}");
      const ch = { reviewer: "демо", reviewed_at: now() };
      if (b.status) ch.status = b.status;
      if (b.cls) { ch.doctor_cls = b.cls; if (!b.status) ch.status = "confirmed"; }
      if (b.note != null) ch.note = b.note;
      Object.assign(f, ch);
      if (id > 0) d.local.edits[id] = Object.assign({}, d.local.edits[id] || {}, ch);
      else { const a = d.local.added.find((x) => x.id === id); if (a) Object.assign(a, ch); }
      save();
      return json(f);
    }
    return json({ detail: "в демо недоступно" }, 400);
  };

  window.CYTO_DEMO = {
    base,
    blank: "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=",
    exportJson(slide, findings) {
      const ann = findings.filter((f) => f.status !== "pending").map((f) => ({
        id: f.id, bbox: [f.x, f.y, f.w, f.h],
        label: f.status === "confirmed" ? (f.doctor_cls || f.cls) : "NEGATIVE",
        ai_label: f.source === "ai" ? f.cls : null, source: f.source,
      }));
      const blob = new Blob([JSON.stringify({ slide: slide.id, annotations: ann }, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${slide.id}_annotations.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    },
  };

  document.addEventListener("DOMContentLoaded", () => {
    const top = document.querySelector(".top .spacer");
    if (!top) return;
    const r = document.createElement("div");
    r.className = "demo-ribbon";
    r.innerHTML = 'Демо: снимок обезличен, отметки сохраняются только в вашем браузере · <a href="#" id="demoReset">сбросить</a>';
    top.before(r);
    r.querySelector("#demoReset").onclick = (e) => {
      e.preventDefault();
      try { localStorage.removeItem(KEY); } catch (err) { /* нет хранилища */ }
      location.reload();
    };
  });
})();
