/* L3 组件层：文件篮 / 设置面板 / 运行区 / 轻提示。
   规则：不直接 fetch（走 api.js）、组件间不互调（走 store.js）。 */
import { api } from "./api.js";
import { store } from "./store.js";

const $ = (id) => document.getElementById(id);

/* ---------------- Toast ---------------- */
let toastTimer = null;
export function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ---------------- FileBasket ---------------- */
export function initFiles() {
  const list = $("file-list");

  function render() {
    const files = store.get("files");
    list.innerHTML = "";
    for (const f of files) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = f;
      name.title = f;
      const rm = document.createElement("button");
      rm.className = "rm";
      rm.textContent = "✕";
      rm.title = "移除";
      rm.addEventListener("click", () =>
        store.set("files", store.get("files").filter((x) => x !== f)));
      li.append(name, rm);
      list.appendChild(li);
    }
  }
  store.on("files", render);

  $("btn-pick").addEventListener("click", async () => {
    const r = await api.pick();
    if (r.error) return toast("选择文件失败：" + r.error);
    if (r.files?.length) {
      const merged = [...new Set([...store.get("files"), ...r.files])];
      store.set("files", merged);
    }
  });
  $("btn-clear").addEventListener("click", () => store.set("files", []));
  render();
}

/* ---------------- SettingsPanel ---------------- */
/* 预设供应商（与 src/gui.py 的 SERVICES 保持一致，改一处必须同步另一处）。
   「自定义」不再是一个预设项：自定义供应商由「＋ 增加自定义配置」现场新建、
   可存任意多个，起好名字后直接出现在供应商下拉里，带自己的模型目录。
   申请入口：DeepSeek platform.deepseek.com；Kimi platform.kimi.com；
   智谱 open.bigmodel.cn；豆包 console.volcengine.com/ark（需先开通模型）。 */
const PRESETS = [
  { name: "DeepSeek 官方", base: "https://api.deepseek.com",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  { name: "Kimi（月之暗面）", base: "https://api.moonshot.cn/v1",
    models: ["kimi-k2.6", "kimi-k3"] },
  { name: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.2"] },
  { name: "豆包（火山方舟）", base: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seed-2.0-pro", "doubao-seed-2.0-lite"] },
  { name: "OpenAI", base: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o"] },
  { name: "Ollama 本地（免费离线）", base: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5:7b", "llama3.1:8b"] },
];
const DOMAINS = ["计算机科学", "通用学术", "生物医学", "物理学", "数学",
                 "电子工程", "化学"];

const CUSTOM = "__custom__";        // 仅「领域」还有自定义项
const NEW_PROVIDER = "__new__";     // 供应商下拉里的「＋ 增加自定义配置」

// 已保存的自定义供应商（结构同 config.custom_providers）
let customProviders = [];
// 当前选中的自定义供应商 id；选预设时为空串
let curProviderId = "";
// 编辑器里的草稿（保存前的副本，取消即丢弃）
let editing = null;
let editingNew = false;
// 打开编辑器前的供应商选择，取消时回退到这里
let lastSel = "p0";

/* 本机服务（Ollama 等）不需要 Key——与后端 pipeline._is_local_url 同口径。 */
function isLocalBase(url) {
  try {
    const h = new URL(url).hostname;
    return ["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"].includes(h);
  } catch {
    return false;
  }
}

/* 「下拉 + 自定义」联动：选到"自定义…"时显示旁边的输入框。
   （datalist 会按已填文字过滤选项，导致"看起来只有一个选项"——弃用。） */
function comboSetup(selId, customId) {
  const sel = $(selId), custom = $(customId);
  sel.addEventListener("change", () => {
    custom.hidden = sel.value !== CUSTOM;
    if (!custom.hidden) custom.focus();
  });
}

function comboFill(selId, options, current) {
  const sel = $(selId), custom = $(selId + "-custom");
  sel.innerHTML = "";
  const opts = [...options];
  if (current && !opts.includes(current)) opts.unshift(current);
  for (const o of opts) sel.add(new Option(o, o));
  sel.add(new Option("自定义…", CUSTOM));
  sel.value = current && opts.includes(current) ? current : opts[0] || CUSTOM;
  custom.hidden = sel.value !== CUSTOM;
}

function comboValue(selId) {
  const sel = $(selId);
  return (sel.value === CUSTOM ? $(selId + "-custom").value : sel.value).trim();
}

let LANGS = null;   // 后端语言表 + 推荐（单一真源，避免前后端不一致）

// 语言推荐提示的关闭状态：只记在内存里，不落盘 ——
// 「每次打开软件都显示，关掉后等换了源/目标语言再出现」就是靠这个变量 + 语言 change 事件实现的。
let recoDismissed = false;

function renderReco() {
  const box = $("lang-reco");
  const tgt = $("s-target").value;
  const r = LANGS && LANGS.recommend && LANGS.recommend[tgt];
  if (!r || recoDismissed) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = "";
  const tip = document.createElement("span");
  tip.innerHTML = `💡 译入此语言推荐用 <b>${r.services}</b>：${r.reason}　`;
  box.appendChild(tip);
  // 若推荐里的首个服务名能匹配某个预设，给一个"切换"按钮
  const first = r.services.split("/")[0].trim();
  const idx = PRESETS.findIndex(
    (s) => s.name.includes(first) || first.includes(s.name.replace(/（.*/, "")));
  if (idx >= 0 && $("s-service").value !== "p" + idx) {
    const btn = document.createElement("button");
    btn.className = "reco-switch";
    btn.textContent = `切换到 ${PRESETS[idx].name}`;
    btn.addEventListener("click", () => {
      applyProvider("p" + idx);
      renderReco();
    });
    box.appendChild(btn);
  }
  const note = document.createElement("div");
  note.className = "reco-note";
  note.textContent = LANGS.note || "";
  box.appendChild(note);
  // 关掉这条提示；换语言时会自动重新出现（见下方 s-source / s-target 的 change 监听）
  const close = document.createElement("button");
  close.className = "reco-close";
  close.type = "button";
  close.title = "关闭提示";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "✕";
  close.addEventListener("click", () => {
    recoDismissed = true;
    box.hidden = true;
  });
  box.appendChild(close);
}

export function initSettings() {
  const svc = $("s-service");
  comboSetup("s-domain", "s-domain-custom");

  svc.addEventListener("change", () => {
    // 「＋ 增加自定义配置」不是真选项：开了新草稿就把下拉退回原选择，
    // 等保存成功后由 applyProvider 重新指向新的供应商。
    if (svc.value === NEW_PROVIDER) {
      svc.value = lastSel;
      return openEditor(newProviderDraft(), true);
    }
    applyProvider(svc.value);
  });
  $("s-target").addEventListener("change", () => {
    recoDismissed = false;
    renderReco();
  });
  // 换源语言也重新给一次推荐（此前关掉的提示会重新出现）
  $("s-source").addEventListener("change", () => {
    recoDismissed = false;
    renderReco();
  });

  $("btn-eye").addEventListener("click", () => {
    const k = $("s-key");
    k.type = k.type === "password" ? "text" : "password";
  });
  $("btn-test").addEventListener("click", async () => {
    toast("正在测试连接…");
    const r = await api.test(collectSettings());
    toast(r.message || (r.ok ? "连接成功" : "连接失败"));
  });
  $("btn-glossary").addEventListener("click", async () => {
    const r = await api.pick("csv");
    if (r.files?.[0]) $("s-glossary").value = r.files[0];
  });
  $("btn-outdir").addEventListener("click", async () => {
    const r = await api.pick("dir");
    if (r.files?.[0]) {
      $("s-outdir").value = r.files[0];
      $("s-out-custom").checked = true;
    }
  });

  initGuide();
  initProviderEditor();

  // 语言表（后端单一真源）+ 配置，并行取
  return Promise.all([api.languages(), api.config()]).then(([langs, cfg]) => {
    LANGS = langs;
    const fillLang = (id, list, cur) => {
      const s = $(id);
      s.innerHTML = "";
      for (const l of list) s.add(new Option(l.name, l.code));
      s.value = list.some((l) => l.code === cur) ? cur : list[0].code;
    };
    fillLang("s-source", langs.sources, cfg.source_lang || "zh");
    fillLang("s-target", langs.targets, cfg.target_lang || "en");

    $("s-key").value = cfg.api_key || "";
    $("s-remember").checked = !!cfg.api_key;
    // API Key 与术语库都在「高级选项」里：还没配 Key 时先展开，否则用户找不到输入框
    if (!cfg.api_key) $("adv").open = true;
    // 首次引导：未配置 Key 且用户没手动关掉过，才显示
    const dismissed = localStorage.getItem("guide-dismissed") === "1";
    if (!cfg.api_key && !isLocalBase(cfg.base_url || "") && !dismissed)
      $("guide-card").hidden = false;
    $("s-baseurl").value = cfg.base_url || "";
    $("s-mode").value = cfg.output_mode || "translated";
    $("s-trial").value = cfg.max_pages || 0;
    $("s-page-range").value = cfg.page_range || "";
    $("s-workers").value = cfg.max_workers || 8;
    $("s-backend").value = cfg.render_backend || "auto";
    $("s-thinking").checked = !!cfg.thinking;
    $("s-auto-glossary").checked = cfg.auto_glossary !== false;
    $("s-direct").checked = cfg.use_system_proxy === false;
    $("s-glossary").value = cfg.glossary_path || "glossary/cs_terms.csv";

    customProviders = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
    fillProviders();
    applyProvider(pickInitialProvider(cfg), cfg.model);

    comboFill("s-domain", DOMAINS, cfg.domain || DOMAINS[0]);
    renderReco();
  });
}

/* ---------------- 供应商：预设 + 自定义 ---------------- */
/* 下拉取值约定：p<序号>=预设，c<id>=已保存的自定义供应商。 */

function fillProviders() {
  const sel = $("s-service");
  sel.innerHTML = "";
  PRESETS.forEach((s, i) => sel.add(new Option(s.name, "p" + i)));
  for (const p of customProviders) sel.add(new Option(p.name || "（未命名）", "c" + p.id));
  sel.add(new Option("＋ 增加自定义配置…", NEW_PROVIDER));
}

/* 模型下拉只列当前供应商的模型，不再有「自定义…」：自定义模型属于
   自定义供应商的模型目录，在高级选项里维护。 */
function fillModels(models, current) {
  const sel = $("s-model");
  sel.innerHTML = "";
  const opts = [...new Set((models || []).filter(Boolean))];
  // 配置里存的模型可能不在目录里（手改过 config.json），仍要能显示出来
  if (current && !opts.includes(current)) opts.unshift(current);
  for (const m of opts) sel.add(new Option(m, m));
  sel.value = current && opts.includes(current) ? current : opts[0] || "";
}

function applyProvider(value, model) {
  const sel = $("s-service");
  if (!value) value = "p0";
  sel.value = value;
  lastSel = value;

  if (value.startsWith("p")) {
    const s = PRESETS[+value.slice(1)];
    if (!s) return;
    curProviderId = "";
    $("s-baseurl").value = s.base;
    fillModels(s.models, model);
    hideEditor();
  } else if (value.startsWith("c")) {
    const p = customProviders.find((x) => "c" + x.id === value);
    if (!p) return;
    curProviderId = p.id;
    $("s-baseurl").value = p.base_url || "";
    if (p.api_key) $("s-key").value = p.api_key;
    fillModels((p.models || []).map((m) => m.id), model);
    // 已保存的自定义供应商：直接展开它的面板，改两下就能保存
    showEditor(p, false);
  }
  renderReco();
}

/* 打开界面时该选中哪个供应商：优先 provider_id，其次按接口地址匹配 */
function pickInitialProvider(cfg) {
  const norm = (u) => (u || "").replace(/\/+$/, "");
  if (cfg.provider_id && customProviders.some((p) => p.id === cfg.provider_id))
    return "c" + cfg.provider_id;
  const base = norm(cfg.base_url);
  const pi = PRESETS.findIndex((p) => norm(p.base) === base);
  if (pi >= 0) return "p" + pi;
  const ci = customProviders.findIndex((p) => norm(p.base_url) === base);
  if (ci >= 0) return "c" + customProviders[ci].id;
  return customProviders.length ? "c" + customProviders[0].id : "p0";
}

/* ---------------- 自定义供应商编辑面板 ---------------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function field(labelText, placeholder, value, onChange) {
  const lb = el("label", null, labelText);
  const inp = el("input");
  inp.placeholder = placeholder || "";
  inp.value = value == null ? "" : value;
  inp.addEventListener("input", () => onChange(inp.value));
  lb.appendChild(inp);
  return lb;
}

function iconBtn(icon, title, onClick) {
  const b = el("button", "cp-rm", icon);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function checkLabel(text, checked, onChange) {
  const lb = el("label", "check inline");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!checked;
  box.addEventListener("change", () => onChange(box.checked));
  lb.append(box, document.createTextNode(" " + text));
  return lb;
}

function newModelDraft(id = "") {
  return {
    id,
    context: "",
    max_output: "",
    inputs: ["text"],
    // 推理档位：开启后把「当前档」的 value 作为 reasoning_effort 随请求发出
    reasoning: {
      enabled: false,
      key: "reasoning_effort",
      active: "",
      tiers: [{ level: "off", value: "none" }, { level: "low", value: "low" }],
    },
    // 其他附带参数（top_p / seed …），直接平铺进请求体
    params: [],
  };
}

function newProviderDraft() {
  return { id: "", name: "", base_url: "", protocol: "openai", api_key: "",
           models: [newModelDraft()] };
}

function showEditor(p, isNew) {
  editing = p;
  editingNew = !!isNew;
  $("cp-title").textContent = isNew ? "新自定义配置" : (p.name || "未命名配置");
  $("cp-delete").hidden = !!isNew;
  $("cp-name").value = p.name || "";
  $("cp-base").value = p.base_url || "";
  $("cp-protocol").value = p.protocol || "openai";
  $("cp-key").value = p.api_key || "";
  $("cp-editor").hidden = false;
  // 进了编辑态就把高级区展开并滚过去，用户不用自己找
  $("adv").open = true;
  renderModels();
}

function hideEditor() {
  editing = null;
  editingNew = false;
  $("cp-editor").hidden = true;
  $("cp-models").innerHTML = "";
}

function renderModels() {
  const box = $("cp-models");
  box.innerHTML = "";
  if (!editing) return;
  if (!editing.models) editing.models = [];
  if (!editing.models.length) {
    box.appendChild(el("p", "cp-empty",
      "还没有模型。点「获取可用模型」自动拉取，或手动「＋ 添加模型」。"));
    return;
  }
  editing.models.forEach((m, i) => box.appendChild(modelCard(m, i)));
}

function modelCard(m, idx) {
  const card = el("div", "cp-model");

  // 模型 ID（可从「获取可用模型」的结果里直接选）+ 删除
  const head = el("div", "cp-row cp-row-2");
  const idIn = el("input");
  idIn.placeholder = "模型 ID（如 swift-1.5-iq3_xxs）";
  idIn.value = m.id || "";
  idIn.setAttribute("list", "cp-model-ids");
  idIn.addEventListener("input", () => { m.id = idIn.value.trim(); });
  head.append(idIn, iconBtn("🗑", "删除此模型", () => {
    editing.models.splice(idx, 1);
    renderModels();
  }));

  // 上下文窗口 / 最大输出：只作记录（有些服务按它截断，方便自己核对）
  const dims = el("div", "grid");
  dims.append(
    field("上下文窗口", "如 256K", m.context, (v) => { m.context = v; }),
    field("最大输出 token", "如 32K", m.max_output, (v) => { m.max_output = v; }));

  // 输入类型
  const types = el("div", "cp-line");
  m.inputs = Array.isArray(m.inputs) ? m.inputs : ["text"];
  const toggleType = (t, on) => {
    const set = new Set(m.inputs);
    if (on) set.add(t); else set.delete(t);
    m.inputs = [...set];
  };
  types.append(el("span", "cp-lbl", "输入类型"),
               checkLabel("文本", m.inputs.includes("text"), (on) => toggleType("text", on)),
               checkLabel("图片", m.inputs.includes("image"), (on) => toggleType("image", on)));

  // 推理等级开关
  m.reasoning = m.reasoning || newModelDraft().reasoning;
  const reasonLine = el("div", "cp-line");
  const swBox = document.createElement("input");
  swBox.type = "checkbox";
  swBox.checked = !!m.reasoning.enabled;
  swBox.addEventListener("change", () => { m.reasoning.enabled = swBox.checked; });
  const sw = el("label", "switch");
  sw.append(swBox, el("i"));
  reasonLine.append(el("span", "cp-lbl", "推理等级"), sw,
                    el("small", "cp-hint",
                       `开启后按选中档位发送 ${m.reasoning.key || "reasoning_effort"}`));

  // 档位表：档位名 / 发给 API 的值 / 当前生效 / 删除
  const tiers = el("div", "cp-table");
  const thead = el("div", "cp-row cp-row-tier cp-thead");
  thead.append(el("span"), el("span", "cp-th", "档位"),
               el("span", "cp-th", "API 参数值"), el("span"));
  tiers.appendChild(thead);
  (m.reasoning.tiers || []).forEach((t, ti) => {
    const row = el("div", "cp-row cp-row-tier");
    const rb = document.createElement("input");
    rb.type = "radio";
    rb.name = "cp-tier-" + idx;
    rb.title = "当前生效档位";
    rb.checked = m.reasoning.active === t.level;
    rb.addEventListener("change", () => { m.reasoning.active = t.level; });
    const lv = el("input");
    lv.placeholder = "off / low / high";
    lv.value = t.level == null ? "" : t.level;
    lv.addEventListener("input", () => {
      if (m.reasoning.active === t.level) m.reasoning.active = lv.value.trim();
      t.level = lv.value.trim();
    });
    const vv = el("input");
    vv.placeholder = "发给 API 的值";
    vv.value = t.value == null ? "" : t.value;
    vv.addEventListener("input", () => { t.value = vv.value; });
    row.append(rb, lv, vv, iconBtn("🗑", "删除此档位", () => {
      m.reasoning.tiers.splice(ti, 1);
      if (m.reasoning.active === t.level) m.reasoning.active = "";
      renderModels();
    }));
    tiers.appendChild(row);
  });
  const addTier = el("button", "btn btn-sm cp-add", "＋ 添加档位");
  addTier.type = "button";
  addTier.addEventListener("click", () => {
    m.reasoning.tiers.push({ level: "", value: "" });
    renderModels();
  });
  tiers.appendChild(addTier);

  // 其他附带参数
  const params = el("div", "cp-table");
  const phead = el("div", "cp-row cp-row-tier cp-thead");
  phead.append(el("span"), el("span", "cp-th", "参数名"),
               el("span", "cp-th", "参数值"), el("span"));
  params.appendChild(phead);
  (m.params || []).forEach((it, pi) => {
    const row = el("div", "cp-row cp-row-tier");
    const k = el("input");
    k.placeholder = "如 top_p";
    k.value = it.key == null ? "" : it.key;
    k.addEventListener("input", () => { it.key = k.value; });
    const v = el("input");
    v.placeholder = "如 0.95";
    v.value = it.value == null ? "" : it.value;
    v.addEventListener("input", () => { it.value = v.value; });
    row.append(el("span"), k, v, iconBtn("🗑", "删除此参数", () => {
      m.params.splice(pi, 1);
      renderModels();
    }));
    params.appendChild(row);
  });
  const addParam = el("button", "btn btn-sm cp-add", "＋ 添加参数");
  addParam.type = "button";
  addParam.addEventListener("click", () => {
    m.params = m.params || [];
    m.params.push({ key: "", value: "" });
    renderModels();
  });
  params.appendChild(addParam);

  card.append(head, dims, types, reasonLine, tiers, params);
  return card;
}

function collectEditor() {
  editing.name = $("cp-name").value.trim();
  editing.base_url = $("cp-base").value.trim();
  editing.protocol = $("cp-protocol").value;
  editing.api_key = $("cp-key").value.trim();
  // 没填模型 ID 的空行丢掉，别把占位行存进配置
  editing.models = (editing.models || []).filter((m) => (m.id || "").trim());
  return editing;
}

function persistProviders() {
  return api.saveConfig({
    custom_providers: customProviders,
    provider_id: curProviderId || "",
  });
}

async function saveProvider() {
  if (!editing) return;
  const p = collectEditor();
  if (!p.name) return toast("请先填写「显示名称」");
  if (!p.base_url) return toast("请先填写「API 地址」");

  if (editingNew) {
    p.id = "cp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    customProviders.push(p);
    editingNew = false;
  } else {
    const i = customProviders.findIndex((x) => x.id === p.id);
    if (i >= 0) customProviders[i] = p; else customProviders.push(p);
  }
  curProviderId = p.id;
  const r = await persistProviders();
  if (r.ok === false) return toast("保存失败：" + (r.error || "未知错误"));
  fillProviders();
  applyProvider("c" + p.id, (p.models[0] || {}).id);
  toast(`已保存「${p.name}」，可在「服务」下拉里直接选`);
}

async function deleteProvider() {
  if (!editing || editingNew) return;
  if (!confirm(`删除自定义配置「${editing.name}」？`)) return;
  customProviders = customProviders.filter((x) => x.id !== editing.id);
  curProviderId = "";
  hideEditor();
  const r = await persistProviders();
  if (r.ok === false) return toast("删除失败：" + (r.error || "未知错误"));
  fillProviders();
  applyProvider("p0");
  toast("已删除该自定义配置");
}

async function fetchModels() {
  const base = $("cp-base").value.trim();
  if (!base) return toast("请先填写 API 地址");
  toast("正在获取模型列表…");
  const r = await api.models({
    base_url: base,
    api_key: $("cp-key").value.trim() || $("s-key").value.trim(),
  });
  if (!r.ok) return toast(r.message || "获取失败");
  // 填进 datalist：模型 ID 输入框点一下就能选，不用手抄
  const dl = $("cp-model-ids");
  dl.innerHTML = "";
  for (const id of r.models) dl.appendChild(new Option(id, id));
  if (!(editing.models || []).length) {
    editing.models = [newModelDraft(r.models[0])];
    renderModels();
  }
  toast(`${r.message}：模型 ID 输入框可直接下拉选`);
}

function initProviderEditor() {
  $("cp-eye").addEventListener("click", () => {
    const k = $("cp-key");
    k.type = k.type === "password" ? "text" : "password";
  });
  $("cp-save").addEventListener("click", saveProvider);
  $("cp-delete").addEventListener("click", deleteProvider);
  $("cp-fetch").addEventListener("click", fetchModels);
  $("cp-add-model").addEventListener("click", () => {
    if (!editing) return;
    editing.models = editing.models || [];
    editing.models.push(newModelDraft());
    renderModels();
  });
  $("cp-cancel").addEventListener("click", () => {
    const back = lastSel;
    hideEditor();
    applyProvider(back);
  });
}

function initGuide() {
  $("guide-dismiss").addEventListener("click", () => {
    $("guide-card").hidden = true;
    localStorage.setItem("guide-dismissed", "1");
  });
  $("guide-try-mock").addEventListener("click", () => {
    $("s-mock").checked = true;
    $("guide-card").hidden = true;
    $("adv").open = true;                        // 展开高级区，让用户看到勾选状态
    toast("已开启离线测试模式，选文件后点开始即可看排版效果");
  });
}

export function collectSettings() {
  return {
    api_key: $("s-key").value.trim(),
    model: $("s-model").value.trim(),
    // 自定义供应商：后端据此找到当前模型的附带参数（model_extra_params）
    provider_id: curProviderId || "",
    custom_providers: customProviders,
    base_url: $("s-baseurl").value.trim() || null,
    output_mode: $("s-mode").value,
    source_lang: $("s-source").value,
    target_lang: $("s-target").value,
    domain: comboValue("s-domain") || null,
    max_pages: Math.max(0, +$("s-trial").value || 0),
    // 指定页码（"1-3,5,8-"）：非空时后端优先用它，忽略 max_pages
    page_range: $("s-page-range").value.trim(),
    max_workers: Math.min(32, Math.max(1, +$("s-workers").value || 8)),
    render_backend: $("s-backend").value,
    thinking: $("s-thinking").checked,
    auto_glossary: $("s-auto-glossary").checked,
    use_system_proxy: !$("s-direct").checked,
    refresh_cache: $("s-refresh").checked,   // 忽略缓存重译（仅本次，不落盘）
    glossary_path: $("s-glossary").value.trim() || null,
  };
}

export function outdirValue() {
  return $("s-out-custom").checked ? $("s-outdir").value.trim() : "";
}

/* ---------------- RunBar + ProgressCard + Results + Log ---------------- */
export function initRun() {
  const bar = $("bar"), pct = $("pct"), log = $("log");
  const status = $("status-line"), results = $("results");
  const progCard = $("progress-card");
  let timer = null, lastLogLen = 0;

  function setRunning(on) {
    store.set("running", on);
    $("btn-start").disabled = on;
    $("btn-cancel").disabled = !on;
    progCard.classList.toggle("running", on);
    document.body.classList.toggle("running", on);
  }

  function showJob(j) {
    bar.style.width = (j.percent || 0) + "%";
    pct.textContent = (j.percent || 0) + "%";
    status.textContent = j.message || "";
    if (j.log.length > lastLogLen) {
      log.textContent += j.log.slice(lastLogLen).join("\n") + "\n";
      lastLogLen = j.log.length;
      log.scrollTop = log.scrollHeight;
    }
    results.innerHTML = "";
    for (const o of j.outputs || []) {
      const li = document.createElement("li");
      const ok = document.createElement("span");
      ok.className = "ok";
      ok.textContent = "✔";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = o.file.split(/[\\/]/).pop();
      const b1 = document.createElement("button");
      b1.className = "btn btn-sm";
      b1.textContent = "打开文件";
      b1.addEventListener("click", () => api.open(o.file));
      const b2 = document.createElement("button");
      b2.className = "btn btn-sm";
      b2.textContent = "打开文件夹";
      b2.addEventListener("click", () => api.open(o.file, true));
      li.append(ok, name, b1, b2);
      results.appendChild(li);
    }
  }

  async function poll(id) {
    let j;
    try {
      j = await api.job(id);
    } catch (e) {
      setRunning(false);
      return toast("与本地服务失联（窗口是否被关闭？）");
    }
    if (j.error) { setRunning(false); return toast(j.error); }
    showJob(j);
    if (j.status === "running") {
      timer = setTimeout(() => poll(id), 600);
    } else {
      setRunning(false);
      toast(j.status === "done" ? "翻译完成 ✔" : j.message);
    }
  }

  $("btn-start").addEventListener("click", async () => {
    const files = store.get("files");
    if (!files.length) return toast("请先选择要翻译的文件");
    const overrides = collectSettings();
    const mock = $("s-mock").checked;
    if (!mock && !overrides.api_key && !isLocalBase(overrides.base_url || ""))
      return toast("请填写 API Key（或勾选离线测试）");
    const outdir = outdirValue();
    if ($("s-out-custom").checked && !outdir)
      return toast("请先选择输出文件夹（或改回“原文件同目录”）");
    log.textContent = ""; lastLogLen = 0; results.innerHTML = "";
    // 记住设置；未勾"记住"时 Key 不落盘（仅本次任务使用）
    const saved = { ...overrides };
    if (!$("s-remember").checked) saved.api_key = "";
    delete saved.refresh_cache;   // 忽略缓存是一次性动作，不写入配置
    await api.saveConfig(saved);
    const r = await api.start({ files, overrides, mock, outdir });
    if (r.error) return toast(r.error);
    store.set("jobId", r.job_id);
    setRunning(true);
    poll(r.job_id);
  });

  $("btn-cancel").addEventListener("click", () => {
    const id = store.get("jobId");
    if (!id) return;
    // 立即反馈：禁用按钮 + 文案，别让用户以为"点了没反应"再猛点。
    // 后端会短路队列中未开始的批、并放弃等待在途请求，通常一两秒内停下。
    $("btn-cancel").disabled = true;
    status.textContent = "正在取消…";
    toast("正在取消…（等当前在途请求返回后停止）");
    api.cancel(id);
  });
}
