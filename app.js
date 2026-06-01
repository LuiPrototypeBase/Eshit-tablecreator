const COLLECTION_SLOTS = [
  ["初恨", "第一次的赤石"],
  ["擅自期待", "怎么看都是你的错吧？"],
  ["智械危机", "转人工 还有人类吗"],
  ["投资失败", "发售之前不是这么说的"],
  ["遭人陷害", "我们是亲友吧？ ... 是吧？"],
  ["噤若寒蝉", "我不敢说。"],
  ["妙手回春", "大夫 我现在彻底养胃了"],
  ["义无反顾", "我有说过这个很难吃吧？"],
  ["好评如潮", "但只有我觉得怪怪的"],
  ["时尚单品", "年轻人都喜欢这个？"],
  ["又好又坏", "史味巧克力？巧克力味史？"],
  ["屡战屡败", "一天不吃难受 吃了难受一天"],
  ["记忆创伤", "已经不记得当时的心情了\n现在的我只想忘记"],
  ["骄纵过度", "溺爱你已经成了习惯"],
  ["猝不及防", "走在路上有辆大运袭来"],
  ["禁果", "在不为人知的角落"],
  ["金玉其表", "起到了好看但难看的作用"],
  ["薪火相传", "互联网的本质是共享"],
  ["戛然而止", "我实在不知道您突然怎么了"],
  ["真神归位", "拼尽全力无法战胜\n360°全方位无死角勾史", true]
];

const ANNUAL_SLOTS = Array.from({ length: 10 }, (_, index) => [`No.${index + 1}`, ""]);
const API_BASE = (window.AKAISHI_API_BASE || "").replace(/\/$/, "");

const state = {
  mode: "collection",
  active: 0,
  dragging: null,
  year: new Date().getFullYear(),
  search: {
    keyword: "",
    type: "2",
    nsfw: false,
    offset: 0,
    limit: 20,
    total: 0,
    loading: false
  },
  templates: {
    collection: createSlots(COLLECTION_SLOTS),
    annual: createSlots(ANNUAL_SLOTS)
  }
};

const grid = document.querySelector("#grid");
const results = document.querySelector("#results");
const slotHint = document.querySelector("#slotHint");
const searchInput = document.querySelector("#searchInput");
const subjectType = document.querySelector("#subjectType");
const includeNsfw = document.querySelector("#includeNsfw");
const activeLabel = document.querySelector("#activeLabel");
const activePrompt = document.querySelector("#activePrompt");
const capture = document.querySelector("#capture");
const yearSelect = document.querySelector("#yearSelect");
const previewWrap = document.querySelector(".preview-wrap");

const typeNames = {
  1: "书籍",
  2: "动画",
  3: "音乐",
  4: "游戏",
  6: "三次元"
};

function proxiedImageUrl(url) {
  return url ? `${API_BASE}/api/image?url=${encodeURIComponent(url)}` : "";
}

function createSlots(source) {
  return source.map(([label, prompt, featured]) => ({ label, prompt, featured: Boolean(featured), subject: null }));
}

function currentSlots() {
  return state.templates[state.mode];
}

function setupYears() {
  const current = Math.min(2099, Math.max(2000, state.year));
  state.year = current;
  for (let year = 2000; year <= 2099; year += 1) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    option.selected = year === current;
    yearSelect.append(option);
  }
}

function renderGrid() {
  grid.innerHTML = "";
  currentSlots().forEach((slot, index) => {
    const button = document.createElement("button");
    button.className = `slot${state.active === index ? " active" : ""}`;
    button.type = "button";
    button.dataset.index = index;
    button.draggable = true;

    const cover = document.createElement("div");
    cover.className = "cover";
    if (slot.subject?.image) {
      const img = document.createElement("img");
      img.crossOrigin = "anonymous";
      img.src = slot.subject.image;
      img.alt = slot.subject.name;
      cover.append(img);
    }

    const label = document.createElement("input");
    label.className = `slot-title-input${getFeaturedClass(slot, index)}`;
    label.value = getSlotLabel(slot, index);
    label.maxLength = state.mode === "annual" ? 16 : 10;
    label.readOnly = state.mode === "annual";
    label.addEventListener("click", event => event.stopPropagation());
    label.addEventListener("input", () => {
      if (state.mode === "annual") return;
      slot.label = label.value;
      if (state.active === index) syncActiveEditor();
    });

    const prompt = document.createElement("div");
    prompt.className = "slot-subtitle";
    prompt.textContent = slot.prompt;

    button.append(cover, label, prompt);
    button.addEventListener("click", () => {
      state.active = index;
      renderGrid();
      syncActiveEditor();
    });
    button.addEventListener("dragstart", event => {
      state.dragging = index;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
      button.classList.add("dragging");
    });
    button.addEventListener("dragend", () => {
      state.dragging = null;
      renderGrid();
    });
    button.addEventListener("dragover", event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      button.classList.add("drop-target");
    });
    button.addEventListener("dragleave", () => {
      button.classList.remove("drop-target");
    });
    button.addEventListener("drop", event => {
      event.preventDefault();
      const from = state.dragging ?? Number(event.dataTransfer.getData("text/plain"));
      moveSlot(from, index);
    });
    grid.append(button);
  });
  fitPosterPreview();
}

function fitPosterPreview() {
  if (!previewWrap) return;
  if (!window.matchMedia("(max-width: 980px)").matches) {
    previewWrap.style.removeProperty("--poster-preview-scale");
    previewWrap.style.removeProperty("--poster-preview-height");
    previewWrap.style.removeProperty("height");
    return;
  }

  const availableWidth = previewWrap.clientWidth - 20;
  const scale = Math.min(1, availableWidth / capture.offsetWidth);
  previewWrap.style.setProperty("--poster-preview-scale", scale);
  previewWrap.style.setProperty("--poster-preview-height", `${capture.offsetHeight * scale}px`);
}

function moveSlot(from, to) {
  const slots = currentSlots();
  if (!Number.isInteger(from) || from === to || from < 0 || to < 0) return;
  const [slot] = slots.splice(from, 1);
  slots.splice(to, 0, slot);
  state.active = to;
  state.dragging = null;
  renderGrid();
  syncActiveEditor();
}

function syncActiveEditor() {
  const slot = currentSlots()[state.active];
  activeLabel.value = getSlotLabel(slot, state.active);
  activeLabel.disabled = state.mode === "annual";
  activePrompt.value = slot.prompt;
  activePrompt.disabled = false;
  slotHint.textContent = `正在填写：${getSlotLabel(slot, state.active)}。点击搜索结果即可放入这个格子。`;
}

function getSlotLabel(slot, index) {
  return state.mode === "annual" ? `No.${index + 1}` : slot.label;
}

function getFeaturedClass(slot, index) {
  if (state.mode === "annual" && index === 0) return " featured-title";
  return slot.featured ? " featured-title" : "";
}

function renderPosterText() {
  const isAnnual = state.mode === "annual";
  document.querySelector("#modeLabel").textContent = isAnnual ? "年度版" : "爱藏版";
  document.querySelector("#yearControl").classList.toggle("hidden-control", !isAnnual);
  document.querySelectorAll(".mode-switch button").forEach(button => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });

  capture.className = `poster ${isAnnual ? "annual-poster" : "collection-poster"}`;
  document.querySelector("#yearMark").textContent = isAnnual ? state.year : "";
  document.querySelector("#mainTitle").innerHTML = isAnnual ? '年度<span class="red-title">赤石</span>' : "赤石表格";
  document.querySelector("#titleText").textContent = isAnnual ? "表格" : "之我赤了这样的石";
  document.querySelector("#makerText").textContent = "Lui";
  document.querySelector("#playerText").textContent = document.querySelector("#playerName").value.trim() || "_____";
  document.querySelector("#noteText").textContent = "本表格仅供娱乐与主观填写，无任何引战，上纲上线意味";
}

async function searchBangumi({ append = false } = {}) {
  const keyword = searchInput.value.trim();
  const type = subjectType.value;
  const nsfw = includeNsfw.checked;
  if (!keyword) return;
  if (state.search.loading) return;

  if (!append || keyword !== state.search.keyword || type !== state.search.type || nsfw !== state.search.nsfw) {
    state.search.keyword = keyword;
    state.search.type = type;
    state.search.nsfw = nsfw;
    state.search.offset = 0;
    state.search.total = 0;
    results.innerHTML = `<div class="hint">搜索中...</div>`;
  }

  state.search.loading = true;
  try {
    const response = await fetch(`${API_BASE}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyword,
        type: Number(type),
        nsfw,
        limit: state.search.limit,
        offset: state.search.offset
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "搜索失败");
    state.search.total = payload.total || 0;
    renderResults(payload.data || [], { append });
    state.search.offset += payload.data?.length || 0;
  } catch (error) {
    if (!append) results.innerHTML = "";
    const message = document.createElement("div");
    message.className = "hint";
    message.textContent = error.message;
    results.append(message);
  } finally {
    state.search.loading = false;
  }
}

function renderResults(items, { append = false } = {}) {
  if (!append) results.innerHTML = "";
  results.querySelector(".load-more")?.remove();
  if (!items.length && !append) {
    results.innerHTML = `<div class="hint">没有找到结果，换个关键词试试。</div>`;
    return;
  }

  items.forEach(item => {
    const button = document.createElement("button");
    button.className = "result";
    button.type = "button";

    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    img.src = proxiedImageUrl(item.images?.small || item.images?.common || "");
    img.alt = item.name_cn || item.name || "Bangumi subject";

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "result-title";
    title.textContent = item.name_cn || item.name;
    const meta = document.createElement("div");
    meta.className = "result-meta";
    meta.textContent = [typeNames[item.type], item.date, item.rating?.score ? `评分 ${item.rating.score}` : ""].filter(Boolean).join(" · ");
    body.append(title, meta);

    button.append(img, body);
    button.addEventListener("click", () => {
      currentSlots()[state.active].subject = {
        id: item.id,
        name: item.name_cn || item.name,
        image: proxiedImageUrl(item.images?.large || item.images?.common || item.images?.small || "")
      };
      renderGrid();
    });
    results.append(button);
  });

  const shown = state.search.offset + items.length;
  if (shown < state.search.total) {
    const more = document.createElement("button");
    more.className = "load-more";
    more.type = "button";
    more.textContent = `加载更多（已显示 ${shown} / ${state.search.total}）`;
    more.addEventListener("click", () => searchBangumi({ append: true }));
    results.append(more);
  }
}

async function exportImage() {
  renderPosterText();
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  const previousTransform = capture.style.transform;
  const previousMargin = capture.style.marginBottom;
  capture.style.transform = "none";
  capture.style.marginBottom = "0";
  const canvas = await html2canvas(capture, {
    backgroundColor: "#202020",
    scale: 2,
    useCORS: true
  });
  capture.style.transform = previousTransform;
  capture.style.marginBottom = previousMargin;
  const link = document.createElement("a");
  link.download = state.mode === "annual" ? `${state.year}年度赤石表格.png` : "赤石表格-爱藏版.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
}

document.querySelector("#playerName").addEventListener("input", renderPosterText);
document.querySelector("#searchBtn").addEventListener("click", searchBangumi);
searchInput.addEventListener("keydown", event => {
  if (event.key === "Enter") searchBangumi();
});
document.querySelector("#clearBtn").addEventListener("click", () => {
  currentSlots().forEach(slot => {
    slot.subject = null;
  });
  renderGrid();
});
document.querySelector("#addSlotBtn").addEventListener("click", () => {
  currentSlots().push({ label: "新赤石", prompt: "写点锐评", featured: false, subject: null });
  state.active = currentSlots().length - 1;
  renderGrid();
  syncActiveEditor();
});
document.querySelector("#removeSlotBtn").addEventListener("click", () => {
  const slots = currentSlots();
  if (slots.length <= 1) return;
  slots.pop();
  state.active = Math.min(state.active, slots.length - 1);
  renderGrid();
  syncActiveEditor();
});
document.querySelectorAll(".mode-switch button").forEach(button => {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    state.active = 0;
    renderPosterText();
    renderGrid();
    syncActiveEditor();
  });
});
yearSelect.addEventListener("change", () => {
  state.year = Number(yearSelect.value);
  renderPosterText();
});
activeLabel.addEventListener("input", () => {
  if (state.mode === "annual") return;
  currentSlots()[state.active].label = activeLabel.value;
  renderGrid();
  syncActiveEditor();
});
activePrompt.addEventListener("input", () => {
  currentSlots()[state.active].prompt = activePrompt.value;
  renderGrid();
  syncActiveEditor();
});
document.querySelector("#exportBtn").addEventListener("click", exportImage);
window.addEventListener("resize", fitPosterPreview);

setupYears();
renderPosterText();
renderGrid();
syncActiveEditor();
