(() => {
  const STATUS = {
    todo: "未着手",
    doing: "進行中",
    review: "確認中",
    done: "完了",
    blocked: "停滞",
  };
  const ZOOM_WIDTH = { day: 36, week: 24, month: 7 };
  const COLORS = ["#c2412d", "#2f6f5e", "#3d5a80", "#c4892a", "#6b4c7a", "#8c4a3a"];
  const DRAFT_KEY = "necomos-gantt-draft-v2";
  const BANNER_KEY = "necomos-gantt-banner-v1";
  const THEME_KEY = "necomos-theme";

  const state = {
    studio: null,
    fileText: "",
    projectId: "",
    view: "chart",
    group: "member",
    zoom: "week",
    status: "all",
    member: "all",
    genre: "all",
    query: "",
    dirty: false,
    session: null,
    canEdit: false,
    syncLabel: "",
    clientId: (() => {
      const key = "necomos-client-id";
      let id = sessionStorage.getItem(key);
      if (!id) {
        id = `client_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        sessionStorage.setItem(key, id);
      }
      return id;
    })(),
    editingTaskId: null,
    editingMemberId: null,
    editingGenreId: null,
    editingMilestoneId: null,
    editingProjectId: null,
  };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function startOfDay(date) {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return startOfDay(next);
  }

  function daysBetween(a, b) {
    return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
  }

  function parseISODate(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function toISODate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function startOfWeek(date) {
    const day = startOfDay(date).getDay();
    return addDays(date, day === 0 ? -6 : 1 - day);
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function slugify(name) {
    const slug = String(name || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return slug || `p_${Date.now().toString(36)}`;
  }

  function uniqueProjectId(name) {
    let id = slugify(name);
    const used = new Set(state.studio.projects.map((item) => item.id));
    if (!used.has(id)) return id;
    let n = 2;
    while (used.has(`${id}-${n}`)) n += 1;
    return `${id}-${n}`;
  }

  function safeColor(color) {
    return /^#[0-9a-fA-F]{6}$/.test(color || "") ? color : "#c2412d";
  }

  function project() {
    if (!state.studio) return null;
    return state.studio.projects.find((item) => item.id === state.projectId) || null;
  }

  function memberById(id) {
    return project()?.members.find((member) => member.id === id);
  }

  function genreById(id) {
    return state.studio?.genres.find((genre) => genre.id === id);
  }

  function visibleTasks() {
    const current = project();
    if (!current) return [];
    const q = state.query.trim().toLowerCase();
    return current.tasks.filter((task) => {
      if (state.status !== "all" && task.status !== state.status) return false;
      if (state.member !== "all" && task.memberId !== state.member) return false;
      if (state.genre !== "all" && task.genreId !== state.genre) return false;
      if (!q) return true;
      return `${task.title} ${task.notes || ""}`.toLowerCase().includes(q);
    });
  }

  function serialize(data) {
    return `${JSON.stringify({
      version: 2,
      studio: data.studio,
      updated: data.updated,
      genres: data.genres,
      projects: data.projects,
    }, null, 2)}\n`;
  }

  let supabase = null;
  let saveTimer = null;

  function studioPayload(data) {
    return {
      version: 2,
      studio: data.studio,
      updated: data.updated,
      genres: data.genres,
      projects: data.projects,
    };
  }

  function markDirty() {
    state.studio.updated = toISODate(new Date());
    state.dirty = true;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: state.studio }));
    scheduleSave();
  }

  function touch() {
    markDirty();
    render();
  }

  function denyEdit() {
    if (state.canEdit) return false;
    setMessage(supabaseConfig()
      ? "GitHubでログインすると編集できます。"
      : "データベース未接続のため、いまは閲覧のみです。", true);
    return true;
  }

  function setMessage(text, isError) {
    const node = $("statusLine");
    node.textContent = text || "";
    node.classList.toggle("is-error", Boolean(isError));
  }

  function fillSettings() {
    $("sStudio").value = state.studio?.studio || "NECOMOS STUDIO";
    $("settingsMessage").textContent = "";
  }

  function supabaseConfig() {
    const cfg = window.NECOMOS_SUPABASE || {};
    if (!cfg.url || !cfg.anonKey) return null;
    return cfg;
  }

  function githubLogin(user) {
    const meta = user?.user_metadata || {};
    return meta.user_name || meta.preferred_username || user?.email || "";
  }

  function setSync(text) {
    state.syncLabel = text || "";
    const node = $("syncLabel");
    if (node) node.textContent = state.syncLabel;
  }

  function paintAuth() {
    const configured = Boolean(supabaseConfig());
    const login = $("loginGitHub");
    const logout = $("logoutGitHub");
    const who = $("sessionUser");
    if (login) login.hidden = !configured || Boolean(state.session);
    if (logout) logout.hidden = !state.session;
    if (who) {
      who.hidden = !state.session;
      who.textContent = state.session ? githubLogin(state.session) : "";
    }
    document.body.dataset.editable = state.canEdit ? "1" : "0";
    document.querySelectorAll(".needs-edit").forEach((node) => {
      node.disabled = !state.canEdit;
    });
  }

  async function ensureClient() {
    const cfg = supabaseConfig();
    if (!cfg) return null;
    if (supabase) return supabase;
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(cfg.url, cfg.anonKey);
    return supabase;
  }

  function scheduleSave() {
    if (!state.canEdit) return;
    clearTimeout(saveTimer);
    setSync("同期中");
    saveTimer = setTimeout(() => {
      pushStudio().catch((error) => setMessage(`保存できませんでした。${error.message}`, true));
    }, 1000);
  }

  async function pushStudio() {
    const client = await ensureClient();
    if (!client || !state.canEdit || !state.studio) return;
    setSync("同期中");
    const { error } = await client.from("studio").upsert({
      id: "necomos",
      data: studioPayload(state.studio),
      client_id: state.clientId,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    state.dirty = false;
    setSync("保存済み");
  }

  function subscribeStudio(client) {
    client.channel("studio-necomos")
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "studio",
        filter: "id=eq.necomos",
      }, (payload) => {
        const row = payload.new;
        if (!row?.data) return;
        if (row.client_id === state.clientId) {
          state.dirty = false;
          setSync("保存済み");
          return;
        }
        if (state.dirty) return;
        applyData(row.data);
        setSync("更新を反映しました");
      })
      .subscribe();
  }

  async function refreshAccess(client) {
    const { data } = await client.auth.getSession();
    state.session = data.session?.user || null;
    state.canEdit = false;
    if (!state.session) {
      paintAuth();
      return;
    }
    const login = githubLogin(state.session);
    const { data: editor } = await client.from("editors").select("github_login").eq("github_login", login).maybeSingle();
    state.canEdit = Boolean(editor);
    paintAuth();
    if (!state.canEdit) setMessage("この GitHub アカウントでは編集できません。", true);
  }

  function pack(tasks) {
    const items = tasks
      .map((task) => ({
        task,
        start: parseISODate(task.start),
        end: parseISODate(task.end),
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds = [];
    items.forEach((item) => {
      let lane = laneEnds.findIndex((end) => end < item.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      item.lane = lane;
    });
    return { items, lanes: Math.max(1, laneEnds.length) };
  }

  function rangeFor(tasks) {
    const today = startOfDay(new Date());
    let min = today;
    let max = addDays(today, 28);
    tasks.forEach((task) => {
      const start = parseISODate(task.start);
      const end = parseISODate(task.end);
      if (start < min) min = start;
      if (end > max) max = end;
    });
    (project()?.milestones || []).forEach((item) => {
      const date = parseISODate(item.date);
      if (date < min) min = date;
      if (date > max) max = date;
    });
    return {
      start: startOfWeek(addDays(min, -7)),
      end: addDays(startOfWeek(addDays(max, 14)), 7),
      today,
    };
  }

  function barColor(task) {
    if (state.group === "genre") return safeColor(memberById(task.memberId)?.color);
    return safeColor(genreById(task.genreId)?.color || "#5c6b7a");
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    $("toggleTheme").textContent = theme === "dark" ? "ライト" : "ダーク";
  }

  function syncThemeButton() {
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    $("toggleTheme").textContent = theme === "dark" ? "ライト" : "ダーク";
  }

  function routeId() {
    const parts = location.hash.replace(/^#/, "").split("/").filter(Boolean);
    return parts[0] || "";
  }

  function go(id) {
    const next = id ? `#/${id}` : "#/";
    if (location.hash === next) render();
    else location.hash = next;
  }

  function renderHome() {
    document.body.dataset.screen = "home";
    document.title = state.studio.studio || "NECOMOS STUDIO";
    const brand = document.querySelector(".studio");
    if (brand) brand.textContent = state.studio.studio || "NECOMOS STUDIO";
    $("updatedLabel").textContent = `${state.dirty ? "下書き " : ""}更新 ${state.studio.updated || "—"}`;
    const today = toISODate(new Date());
    const cards = state.studio.projects.map((item) => {
      const next = (item.milestones || [])
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .find((milestone) => milestone.date >= today);
      const done = item.tasks.filter((task) => task.status === "done").length;
      const nextText = next ? ` ・ 次の節目 ${next.date.replaceAll("-", "/")} ${next.title}` : "";
      return `<a class="card" href="#/${esc(item.id)}"><strong>${esc(item.name)}</strong><span>${item.tasks.length} タスク ・ 完了 ${done}${esc(nextText)}</span></a>`;
    }).join("");
    const create = state.canEdit
      ? `<button type="button" class="card needs-edit" id="createProject"><strong>新しいプロジェクト</strong><span>名前を付けてガントを追加します</span></button>`
      : "";
    $("main").innerHTML = `<div class="cards">${cards}${create}</div>`;
    paintAuth();
  }

  function renderChrome() {
    const current = project();
    document.body.dataset.screen = "project";
    $("projectTitle").textContent = current.name;
    document.title = `${current.name} · ${state.studio.studio || "NECOMOS STUDIO"}`;
    const brand = document.querySelector(".studio");
    if (brand) brand.textContent = state.studio.studio || "NECOMOS STUDIO";
    const counts = Object.keys(STATUS).map((key) => {
      const count = current.tasks.filter((task) => task.status === key).length;
      return `${STATUS[key]} ${count}`;
    });
    $("updatedLabel").textContent = `${state.dirty ? "下書き " : ""}更新 ${state.studio.updated || "—"} ・ ${counts.join(" / ")} ・ 節目 ${current.milestones.length}`;

    $("projectJump").innerHTML = state.studio.projects.map((item) => (
      `<option value="${esc(item.id)}"${item.id === current.id ? " selected" : ""}>${esc(item.name)}</option>`
    )).join("");

    $("statusChips").innerHTML = ["all", ...Object.keys(STATUS)].map((key) => {
      const label = key === "all" ? "すべて" : STATUS[key];
      return `<button type="button" class="${state.status === key ? "is-on" : ""}" data-status="${key}">${label}</button>`;
    }).join("");

    const memberButtons = [`<button type="button" class="chip${state.member === "all" ? " is-on" : ""}" data-member="all">全員</button>`];
    current.members.forEach((member) => {
      const color = safeColor(member.color);
      memberButtons.push(`<button type="button" class="chip${state.member === member.id ? " is-on" : ""}" data-member="${esc(member.id)}" style="--person:${color}"><i class="swatch" style="background:${color}"></i>${esc(member.name)}</button>`);
    });
    $("memberChips").innerHTML = memberButtons.join("");

    const genreButtons = [`<button type="button" class="chip${state.genre === "all" ? " is-on" : ""}" data-genre="all">すべて</button>`];
    state.studio.genres.forEach((genre) => {
      const color = safeColor(genre.color);
      genreButtons.push(`<button type="button" class="chip${state.genre === genre.id ? " is-on" : ""}" data-genre="${esc(genre.id)}" style="--kind:${color}">${esc(genre.name)}</button>`);
    });
    $("genreChips").innerHTML = genreButtons.join("");

    document.querySelectorAll("[data-zoom]").forEach((button) => {
      button.classList.toggle("is-on", button.dataset.zoom === state.zoom);
    });
    $("viewChart").classList.toggle("is-on", state.view === "chart");
    $("viewList").classList.toggle("is-on", state.view === "list");
    $("viewChart").setAttribute("aria-pressed", String(state.view === "chart"));
    $("viewList").setAttribute("aria-pressed", String(state.view === "list"));
    $("groupMember").classList.toggle("is-on", state.group === "member");
    $("groupGenre").classList.toggle("is-on", state.group === "genre");
    $("groupMember").setAttribute("aria-pressed", String(state.group === "member"));
    $("groupGenre").setAttribute("aria-pressed", String(state.group === "genre"));
  }

  function milestoneHtml() {
    const items = (project()?.milestones || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!items.length) return "";
    return `<div class="ms-list">${items.map((item) => (
      `<button type="button" data-edit-milestone="${esc(item.id)}">${esc(item.date.replaceAll("-", "/"))} ${esc(item.title)}</button>`
    )).join("")}</div>`;
  }

  function renderList(tasks) {
    if (!tasks.length) {
      $("main").innerHTML = `${milestoneHtml()}<div class="empty">該当するタスクがありません。</div>`;
      return;
    }
    const rows = tasks
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, "ja"))
      .map((task) => {
        const member = memberById(task.memberId);
        const genre = genreById(task.genreId);
        return `<tr>
          <td><i class="swatch" style="background:${safeColor(member?.color)}"></i>${esc(member?.name || "未定")}</td>
          <td><i class="swatch" style="background:${safeColor(genre?.color)}"></i>${esc(genre?.name || "未分類")}</td>
          <td><button type="button" class="linkish" data-edit-task="${esc(task.id)}">${esc(task.title)}</button></td>
          <td>${esc(task.start)}</td>
          <td>${esc(task.end)}</td>
          <td><input type="range" min="0" max="100" value="${Number(task.progress) || 0}" data-progress="${esc(task.id)}" aria-label="${esc(task.title)}の進捗"><span class="pct">${Number(task.progress) || 0}%</span></td>
          <td>${esc(STATUS[task.status] || task.status)}</td>
        </tr>`;
      }).join("");
    $("main").innerHTML = `${milestoneHtml()}<table class="list"><thead><tr><th>担当</th><th>ジャンル</th><th>タスク</th><th>開始</th><th>終了</th><th>進捗</th><th>状態</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function laneDefs() {
    const current = project();
    if (state.group === "genre") {
      return state.studio.genres
        .filter((genre) => state.genre === "all" || genre.id === state.genre)
        .map((genre) => ({
          id: genre.id,
          name: genre.name,
          role: "",
          color: genre.color,
          kind: "genre",
        }));
    }
    return current.members
      .filter((member) => state.member === "all" || member.id === state.member)
      .map((member) => ({
        id: member.id,
        name: member.name,
        role: member.role || "",
        color: member.color,
        kind: "member",
      }));
  }

  function tasksInLane(lane, tasks) {
    if (lane.kind === "genre") return tasks.filter((task) => task.genreId === lane.id);
    return tasks.filter((task) => task.memberId === lane.id);
  }

  function renderChart(tasks) {
    const current = project();
    const dayWidth = ZOOM_WIDTH[state.zoom];
    const allForRange = current.tasks.length ? current.tasks : tasks;
    const range = rangeFor(allForRange);
    const totalDays = Math.max(1, daysBetween(range.start, range.end));
    const timelineWidth = totalDays * dayWidth;

    const months = [];
    const ticks = [];
    const weekends = [];
    for (let i = 0; i < totalDays; i += 1) {
      const date = addDays(range.start, i);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      const last = months[months.length - 1];
      if (!last || last.key !== key) months.push({ key, index: i, label: `${date.getFullYear()}/${date.getMonth() + 1}`, span: 1 });
      else last.span = i - last.index + 1;

      const weekday = date.getDay();
      if (weekday === 0 || weekday === 6) weekends.push(i);
      const showTick = state.zoom === "day" || (state.zoom === "week" && weekday === 1) || (state.zoom === "month" && date.getDate() === 1);
      if (showTick) {
        ticks.push(`<span class="tick-label" style="left:${i * dayWidth}px;width:${Math.max(dayWidth, 36)}px">${date.getMonth() + 1}/${date.getDate()}</span>`);
      }
    }

    const monthHtml = months.map((month) => (
      `<span class="month-label" style="left:${month.index * dayWidth}px;width:${month.span * dayWidth}px">${month.label}</span>`
    )).join("");
    const weekendHtml = state.zoom === "month" ? "" : weekends.map((index) => (
      `<i class="weekend" style="left:${index * dayWidth}px;width:${dayWidth}px"></i>`
    )).join("");

    const todayIndex = daysBetween(range.start, range.today);
    const showToday = todayIndex >= 0 && todayIndex <= totalDays;
    const todayMark = showToday
      ? `<div class="today-mark" style="left:${todayIndex * dayWidth}px"><span>今日</span></div>`
      : "";
    const todayLine = showToday
      ? `<div class="today-line" style="left:calc(var(--lane-w) + ${todayIndex * dayWidth}px)"></div>`
      : "";

    const rows = laneDefs().map((lane) => {
      const mine = tasksInLane(lane, tasks);
      const packed = pack(mine);
      const height = Math.max(52, packed.lanes * 36 + 16);
      const bars = packed.items.map(({ task, lane: stack }) => {
        const color = barColor(task);
        const start = parseISODate(task.start);
        const end = parseISODate(task.milestone ? task.start : task.end);
        const left = daysBetween(range.start, start) * dayWidth;
        const width = Math.max(dayWidth, (daysBetween(start, end) + 1) * dayWidth);
        const progress = Math.min(100, Math.max(0, Number(task.progress) || 0));
        if (task.milestone) {
          return `<button type="button" class="bar is-milestone is-${esc(task.status)}" data-task="${esc(task.id)}" data-mode="move" style="left:${left}px;top:${12 + stack * 36}px;--bar:${color};background:${color}" title="${esc(task.title)} ${esc(task.start)}"><span class="bar-label">${esc(task.title)}</span></button>`;
        }
        return `<button type="button" class="bar is-${esc(task.status)}" data-task="${esc(task.id)}" style="left:${left}px;top:${10 + stack * 36}px;width:${width}px;background:color-mix(in srgb, ${color} 28%, var(--surface))" title="${esc(task.title)} ${esc(task.start)}–${esc(task.end)} ${progress}%">
          <span class="bar-fill" style="width:${progress}%;background:${color}"></span>
          <span class="handle w" data-mode="start"></span>
          <span class="handle e" data-mode="end"></span>
          <span class="bar-label">${esc(task.title)}</span>
        </button>`;
      }).join("");
      const note = mine.length ? `${mine.length}件` : "タスクなし";
      const role = lane.role ? `${lane.role} ・ ` : "";
      const editAttr = lane.kind === "genre" ? `data-edit-genre="${esc(lane.id)}"` : `data-edit-member="${esc(lane.id)}"`;
      return `<div class="row" data-lane-id="${esc(lane.id)}" data-lane-kind="${esc(lane.kind)}">
        <div class="lane"><button type="button" class="lane-btn" ${editAttr}><strong><i class="swatch" style="background:${safeColor(lane.color)}"></i>${esc(lane.name)}</strong><span>${esc(role)}${note}</span></button></div>
        <div class="track" data-lane-id="${esc(lane.id)}" data-lane-kind="${esc(lane.kind)}" data-range-start="${toISODate(range.start)}" style="width:${timelineWidth}px;height:${height}px">${weekendHtml}${bars}</div>
      </div>`;
    }).join("");

    const milestones = current.milestones.slice().sort((a, b) => a.date.localeCompare(b.date));
    const milestoneMarks = milestones.map((item) => {
      const index = daysBetween(range.start, parseISODate(item.date));
      if (index < 0 || index > totalDays) return "";
      return `<button type="button" class="ms-mark" data-milestone="${esc(item.id)}" style="left:${index * dayWidth}px" title="${esc(item.title)} ${esc(item.date)}">${esc(item.title)}</button>`;
    }).join("");
    const milestoneLines = milestones.map((item) => {
      const index = daysBetween(range.start, parseISODate(item.date));
      if (index < 0 || index > totalDays) return "";
      return `<div class="milestone-line" data-milestone-line="${esc(item.id)}" style="left:calc(var(--lane-w) + ${index * dayWidth}px)"></div>`;
    }).join("");
    const milestoneRow = `<div class="row milestone-row">
      <div class="lane"><strong>節目</strong><span>${milestones.length}件</span></div>
      <div class="track" style="width:${timelineWidth}px;height:40px">${milestoneMarks}</div>
    </div>`;
    const laneLabel = state.group === "genre" ? "ジャンル" : "メンバー";

    $("main").innerHTML = `<div class="gantt-scroll" id="ganttScroll"><div class="gantt-canvas" style="width:${timelineWidth + 210}px">
      <div class="gantt-header">
        <div class="lane">${laneLabel}</div>
        <div class="time-head" style="width:${timelineWidth}px">${monthHtml}${ticks.join("")}${todayMark}</div>
      </div>
      ${milestoneRow}
      ${rows || `<div class="empty">${laneLabel}がいません。</div>`}
      ${todayLine}
      ${milestoneLines}
    </div></div>`;

    const scroller = $("ganttScroll");
    if (todayIndex >= 0) scroller.scrollLeft = Math.max(0, todayIndex * dayWidth - scroller.clientWidth * 0.35);
  }

  function render() {
    if (!state.studio) return;
    state.projectId = routeId();
    if (!project()) {
      if (state.projectId) setMessage("そのプロジェクトは見つかりません。", true);
      renderHome();
      return;
    }
    renderChrome();
    const tasks = visibleTasks();
    if (state.view === "list") renderList(tasks);
    else renderChart(tasks);
    paintAuth();
  }

  function openTaskDialog(task, preset) {
    if (denyEdit()) return;
    const current = project();
    if (!current.members.length) {
      setMessage("先にメンバーを追加してください。", true);
      return;
    }
    if (!state.studio.genres.length) {
      setMessage("先にジャンルを追加してください。", true);
      return;
    }
    state.editingTaskId = task?.id || null;
    $("taskDialogTitle").textContent = task ? "タスクを編集" : "タスクを追加";
    $("deleteTask").hidden = !task;
    $("fTitle").value = task?.title || "";
    $("fMember").innerHTML = current.members.map((member) => (
      `<option value="${esc(member.id)}">${esc(member.name)}</option>`
    )).join("");
    $("fMember").value = task?.memberId || preset?.memberId || (state.member !== "all" ? state.member : current.members[0].id);
    $("fGenre").innerHTML = state.studio.genres.map((genre) => (
      `<option value="${esc(genre.id)}">${esc(genre.name)}</option>`
    )).join("");
    $("fGenre").value = task?.genreId || preset?.genreId || (state.genre !== "all" ? state.genre : state.studio.genres[0].id);
    $("fStatus").innerHTML = Object.entries(STATUS).map(([key, label]) => `<option value="${key}">${label}</option>`).join("");
    $("fStatus").value = task?.status || "todo";
    $("fProgress").value = String(task?.progress ?? 0);
    $("fProgressLabel").textContent = `${$("fProgress").value}%`;
    const today = toISODate(new Date());
    $("fStart").value = task?.start || preset?.start || today;
    $("fEnd").value = task?.end || preset?.end || toISODate(addDays(new Date(), 6));
    $("fMilestone").checked = Boolean(task?.milestone);
    $("fEnd").disabled = $("fMilestone").checked;
    $("fNotes").value = task?.notes || "";
    $("fLink").value = task?.link || "";
    $("taskDialog").showModal();
    $("fTitle").focus();
  }

  function readTaskForm() {
    const milestone = $("fMilestone").checked;
    const start = $("fStart").value;
    let end = milestone ? start : $("fEnd").value;
    if (!milestone && end < start) end = start;
    let progress = Number($("fProgress").value);
    if ($("fStatus").value === "done") progress = 100;
    return {
      id: state.editingTaskId || uid("task"),
      memberId: $("fMember").value,
      genreId: $("fGenre").value,
      title: $("fTitle").value.trim(),
      start,
      end,
      progress,
      status: $("fStatus").value,
      milestone,
      notes: $("fNotes").value.trim(),
      link: $("fLink").value.trim(),
    };
  }

  function openMemberDialog(member) {
    if (denyEdit()) return;
    state.editingMemberId = member?.id || null;
    $("memberDialogTitle").textContent = member ? "メンバーを編集" : "メンバーを追加";
    $("deleteMember").hidden = !member;
    $("mName").value = member?.name || "";
    $("mRole").value = member?.role || "";
    $("mColor").value = safeColor(member?.color || COLORS[project().members.length % COLORS.length]);
    $("memberDialog").showModal();
    $("mName").focus();
  }

  function openGenreDialog(genre) {
    if (denyEdit()) return;
    state.editingGenreId = genre?.id || null;
    $("genreDialogTitle").textContent = genre ? "ジャンルを編集" : "ジャンルを追加";
    $("deleteGenre").hidden = !genre;
    $("gName").value = genre?.name || "";
    $("gColor").value = safeColor(genre?.color || COLORS[state.studio.genres.length % COLORS.length]);
    $("genreDialog").showModal();
    $("gName").focus();
  }

  function openMilestoneDialog(item) {
    if (denyEdit()) return;
    state.editingMilestoneId = item?.id || null;
    $("milestoneDialogTitle").textContent = item ? "マイルストーンを編集" : "マイルストーンを追加";
    $("deleteMilestone").hidden = !item;
    $("msTitle").value = item?.title || "";
    $("msDate").value = item?.date || toISODate(new Date());
    $("milestoneDialog").showModal();
    $("msTitle").focus();
  }

  function openProjectDialog(item) {
    if (denyEdit()) return;
    state.editingProjectId = item?.id || null;
    $("projectDialogTitle").textContent = item ? "プロジェクトを編集" : "プロジェクトを追加";
    $("deleteProject").hidden = !item;
    $("pName").value = item?.name || "";
    $("projectDialog").showModal();
    $("pName").focus();
  }

  function shiftTask(task, mode, delta) {
    if (!delta) return;
    const start = parseISODate(task.start);
    const end = parseISODate(task.end);
    if (mode === "move") {
      task.start = toISODate(addDays(start, delta));
      task.end = toISODate(addDays(end, delta));
    } else if (mode === "start") {
      const next = addDays(start, delta);
      task.start = toISODate(next > end ? end : next);
    } else if (mode === "end") {
      const next = addDays(end, delta);
      task.end = toISODate(next < start ? start : next);
    }
    if (task.milestone) task.end = task.start;
  }

  function downloadJson() {
    if ($("sStudio") && state.studio) {
      const name = $("sStudio").value.trim();
      if (name) state.studio.studio = name;
    }
    const blob = new Blob([serialize(state.studio)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "schedule.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  function normalize(data) {
    if (data?.version === 2 && Array.isArray(data.projects)) {
      data.studio = data.studio || "NECOMOS STUDIO";
      data.genres = Array.isArray(data.genres) ? data.genres : [];
      data.projects.forEach((item) => {
        item.members = item.members || [];
        item.milestones = item.milestones || [];
        item.tasks = item.tasks || [];
      });
      return data;
    }
    if (data && Array.isArray(data.members) && Array.isArray(data.tasks)) {
      return {
        version: 2,
        studio: "NECOMOS STUDIO",
        updated: data.updated || toISODate(new Date()),
        genres: [],
        projects: [{
          id: "debujong",
          name: data.project || "プロジェクト",
          members: data.members,
          milestones: data.milestones || [],
          tasks: data.tasks.map((task) => ({ ...task, genreId: task.genreId || "" })),
        }],
      };
    }
    throw new Error("schedule.json の形式が違います。");
  }

  function applyData(data, fileText) {
    state.studio = normalize(data);
    state.fileText = fileText || serialize(state.studio);
    state.dirty = false;
    $("banner").classList.toggle("is-hidden", localStorage.getItem(BANNER_KEY) === "1");
    render();
  }

  async function loadFile() {
    const response = await fetch("./schedule.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`schedule.json を読めませんでした (${response.status})`);
    const text = await response.text();
    return { text, data: JSON.parse(text) };
  }

  async function load() {
    const file = await loadFile();
    const client = await ensureClient();
    if (!client) {
      applyData(file.data, file.text);
      setMessage("データベース未接続のため、いまは閲覧のみです。");
      paintAuth();
      return;
    }
    try {
      await refreshAccess(client);
      const { data: row, error } = await client.from("studio").select("data, client_id").eq("id", "necomos").maybeSingle();
      if (error) throw error;
      if (row?.data) {
        applyData(row.data);
      } else {
        applyData(file.data, file.text);
        if (state.canEdit) await pushStudio();
      }
      subscribeStudio(client);
      if (!state.session) setMessage("閲覧中です。編集するには GitHub でログインしてください。");
    } catch (error) {
      applyData(file.data, file.text);
      state.canEdit = false;
      setMessage("データベースの準備が終わると、ログインして編集できます。");
    }
    paintAuth();
  }

  function bindMilestoneDrag(event) {
    if (denyEdit()) return;
    const mark = event.target.closest(".ms-mark");
    const current = project();
    const item = current.milestones.find((entry) => entry.id === mark.dataset.milestone);
    if (!item || event.button !== 0) return;
    const originX = event.clientX;
    const snapshot = item.date;
    const rangeStart = rangeFor(current.tasks).start;
    const line = document.querySelector(`[data-milestone-line="${CSS.escape(item.id)}"]`);
    let moved = false;
    const move = (ev) => {
      const delta = Math.round((ev.clientX - originX) / ZOOM_WIDTH[state.zoom]);
      if (Math.abs(ev.clientX - originX) > 4) moved = true;
      item.date = toISODate(addDays(parseISODate(snapshot), delta));
      const left = daysBetween(rangeStart, parseISODate(item.date)) * ZOOM_WIDTH[state.zoom];
      mark.style.left = `${left}px`;
      if (line) line.style.left = `calc(var(--lane-w) + ${left}px)`;
      mark.title = `${item.title} ${item.date}`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (item.date !== snapshot) touch();
      else if (!moved) openMilestoneDialog(item);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  let ignoreTrackClick = false;

  function laneTrackAt(x, y, ignore) {
    const hits = document.elementsFromPoint(x, y);
    for (const hit of hits) {
      if (ignore && (hit === ignore || ignore.contains(hit))) continue;
      const row = hit.closest(".row[data-lane-kind]");
      if (row) return row.querySelector(".track");
    }
    return null;
  }

  function laneField(kind) {
    return kind === "genre" ? "genreId" : "memberId";
  }

  function markDropRow(track) {
    document.querySelectorAll(".row.is-drop").forEach((row) => row.classList.remove("is-drop"));
    track?.closest(".row")?.classList.add("is-drop");
  }

  function createTaskAt(track, event) {
    if (!track?.dataset.rangeStart || !track.dataset.laneId) return;
    const x = event.clientX - track.getBoundingClientRect().left;
    const index = Math.max(0, Math.floor(x / ZOOM_WIDTH[state.zoom]));
    const startDate = addDays(parseISODate(track.dataset.rangeStart), index);
    const preset = {
      start: toISODate(startDate),
      end: toISODate(addDays(startDate, 6)),
    };
    if (track.dataset.laneKind === "member") preset.memberId = track.dataset.laneId;
    if (track.dataset.laneKind === "genre") preset.genreId = track.dataset.laneId;
    openTaskDialog(null, preset);
  }

  function bindChartDragOnce(event) {
    if (denyEdit()) return;
    const bar = event.target.closest(".bar");
    const task = project().tasks.find((item) => item.id === bar.dataset.task);
    if (!task) return;
    const mode = event.target.dataset.mode || "move";
    if (task.milestone && mode !== "move") return;
    if (event.button !== 0) return;
    ignoreTrackClick = true;
    const originX = event.clientX;
    const originY = event.clientY;
    const snapshot = { start: task.start, end: task.end, memberId: task.memberId, genreId: task.genreId };
    const rangeStart = rangeFor(project().tasks).start;
    let moved = false;
    const move = (ev) => {
      const delta = Math.round((ev.clientX - originX) / ZOOM_WIDTH[state.zoom]);
      if (Math.abs(ev.clientX - originX) > 4 || Math.abs(ev.clientY - originY) > 4) moved = true;
      task.start = snapshot.start;
      task.end = snapshot.end;
      shiftTask(task, mode, delta);
      const left = daysBetween(rangeStart, parseISODate(task.start)) * ZOOM_WIDTH[state.zoom];
      const width = Math.max(
        ZOOM_WIDTH[state.zoom],
        (daysBetween(parseISODate(task.start), parseISODate(task.end)) + 1) * ZOOM_WIDTH[state.zoom],
      );
      bar.style.left = `${left}px`;
      if (!task.milestone) bar.style.width = `${width}px`;
      if (mode === "move") {
        bar.style.pointerEvents = "none";
        bar.style.zIndex = "5";
        bar.style.transform = `translateY(${ev.clientY - originY}px)`;
        const track = laneTrackAt(ev.clientX, ev.clientY, bar);
        const field = track ? laneField(track.dataset.laneKind) : "";
        markDropRow(field && track.dataset.laneId !== snapshot[field] ? track : null);
      }
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      markDropRow(null);
      let reassigned = false;
      if (mode === "move") {
        const track = laneTrackAt(ev.clientX, ev.clientY, bar);
        const field = track ? laneField(track.dataset.laneKind) : "";
        if (field && track.dataset.laneId && track.dataset.laneId !== snapshot[field]) {
          task[field] = track.dataset.laneId;
          reassigned = true;
        }
      }
      const changed = reassigned || task.start !== snapshot.start || task.end !== snapshot.end;
      if (changed) touch();
      else {
        bar.style.pointerEvents = "";
        bar.style.zIndex = "";
        bar.style.transform = "";
        if (!moved) openTaskDialog(task);
      }
      setTimeout(() => { ignoreTrackClick = false; }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function rosterRow(kind, item) {
    const color = safeColor(item?.color || COLORS[0]);
    const role = kind === "member"
      ? `<input class="roster-role" maxlength="40" placeholder="役割" value="${esc(item?.role || "")}">`
      : "";
    return `<div class="roster-row" data-id="${esc(item?.id || "")}">
      <input class="roster-color" type="color" value="${color}" aria-label="色">
      <input class="roster-name" maxlength="40" placeholder="名前" value="${esc(item?.name || "")}" required>
      ${role}
      <button type="button" class="btn danger roster-remove">削除</button>
    </div>`;
  }

  function openMemberRoster() {
    if (denyEdit()) return;
    const current = project();
    $("memberRosterMessage").textContent = "";
    $("memberRosterList").innerHTML = current.members.map((member) => rosterRow("member", member)).join("");
    $("memberRoster").showModal();
  }

  function openGenreRoster() {
    if (denyEdit()) return;
    $("genreRosterMessage").textContent = "";
    $("genreRosterList").innerHTML = state.studio.genres.map((genre) => rosterRow("genre", genre)).join("");
    $("genreRoster").showModal();
  }

  function readRoster(list, kind) {
    const rows = [...list.querySelectorAll(".roster-row")];
    const items = [];
    for (const row of rows) {
      const name = row.querySelector(".roster-name").value.trim();
      if (!name) return { error: "名前が空の行があります。", row };
      const item = {
        id: row.dataset.id || uid(kind),
        name,
        color: safeColor(row.querySelector(".roster-color").value),
      };
      if (kind === "member") item.role = row.querySelector(".roster-role").value.trim();
      items.push(item);
    }
    return { items };
  }

  function bind() {
    syncThemeButton();
    $("toggleTheme").onclick = () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
    };
    $("groupMember").onclick = () => { state.group = "member"; render(); };
    $("groupGenre").onclick = () => { state.group = "genre"; render(); };
    $("viewChart").onclick = () => { state.view = "chart"; render(); };
    $("viewList").onclick = () => { state.view = "list"; render(); };
    document.querySelectorAll("[data-zoom]").forEach((button) => {
      button.onclick = () => { state.zoom = button.dataset.zoom; render(); };
    });
    $("projectJump").onchange = () => { go($("projectJump").value); };
    $("search").oninput = () => { state.query = $("search").value; render(); };
    $("statusChips").onclick = (event) => {
      const button = event.target.closest("[data-status]");
      if (!button) return;
      state.status = button.dataset.status;
      render();
    };
    $("memberChips").onclick = (event) => {
      const button = event.target.closest("[data-member]");
      if (!button) return;
      state.member = button.dataset.member;
      render();
    };
    $("genreChips").onclick = (event) => {
      const button = event.target.closest("[data-genre]");
      if (!button) return;
      state.genre = button.dataset.genre;
      render();
    };
    $("addTask").onclick = () => openTaskDialog(null);
    $("openMembers").onclick = () => openMemberRoster();
    $("openGenres").onclick = () => openGenreRoster();
    $("addMilestone").onclick = () => openMilestoneDialog(null);
    $("editProject").onclick = () => openProjectDialog(project());

    $("closeMemberRoster").onclick = () => $("memberRoster").close();
    $("cancelMemberRoster").onclick = () => $("memberRoster").close();
    $("memberRosterAdd").onclick = () => {
      $("memberRosterList").insertAdjacentHTML("beforeend", rosterRow("member", {
        color: COLORS[project().members.length % COLORS.length],
      }));
      $("memberRosterList").lastElementChild.querySelector(".roster-name").focus();
    };
    $("memberRosterList").onclick = (event) => {
      const button = event.target.closest(".roster-remove");
      if (!button) return;
      const row = button.closest(".roster-row");
      const member = memberById(row.dataset.id);
      const owned = member ? project().tasks.filter((task) => task.memberId === member.id).length : 0;
      if (owned && !window.confirm(`「${member.name}」とタスク ${owned} 件を削除しますか？`)) return;
      row.remove();
    };
    $("memberRosterForm").onsubmit = (event) => {
      event.preventDefault();
      const current = project();
      const result = readRoster($("memberRosterList"), "member");
      if (result.error) {
        $("memberRosterMessage").textContent = result.error;
        result.row.querySelector(".roster-name").focus();
        return;
      }
      const removed = current.members.filter((member) => !result.items.some((item) => item.id === member.id));
      current.members = result.items;
      const removedIds = new Set(removed.map((member) => member.id));
      current.tasks = current.tasks.filter((task) => !removedIds.has(task.memberId));
      if (removedIds.has(state.member)) state.member = "all";
      $("memberRoster").close();
      touch();
    };

    $("closeGenreRoster").onclick = () => $("genreRoster").close();
    $("cancelGenreRoster").onclick = () => $("genreRoster").close();
    $("genreRosterAdd").onclick = () => {
      $("genreRosterList").insertAdjacentHTML("beforeend", rosterRow("genre", {
        color: COLORS[state.studio.genres.length % COLORS.length],
      }));
      $("genreRosterList").lastElementChild.querySelector(".roster-name").focus();
    };
    $("genreRosterList").onclick = (event) => {
      const button = event.target.closest(".roster-remove");
      if (!button) return;
      const row = button.closest(".roster-row");
      const genre = genreById(row.dataset.id);
      const owned = genre ? state.studio.projects.reduce((sum, item) => (
        sum + item.tasks.filter((task) => task.genreId === genre.id).length
      ), 0) : 0;
      if (owned && !window.confirm(`「${genre.name}」を外すと、付いているタスク ${owned} 件はジャンル未設定になります。削除しますか？`)) return;
      row.remove();
    };
    $("genreRosterForm").onsubmit = (event) => {
      event.preventDefault();
      const result = readRoster($("genreRosterList"), "genre");
      if (result.error) {
        $("genreRosterMessage").textContent = result.error;
        result.row.querySelector(".roster-name").focus();
        return;
      }
      const removed = state.studio.genres.filter((genre) => !result.items.some((item) => item.id === genre.id));
      const removedIds = new Set(removed.map((genre) => genre.id));
      state.studio.genres = result.items;
      state.studio.projects.forEach((item) => {
        item.tasks.forEach((task) => {
          if (removedIds.has(task.genreId)) task.genreId = "";
        });
      });
      if (removedIds.has(state.genre)) state.genre = "all";
      $("genreRoster").close();
      touch();
    };

    $("closeMilestone").onclick = () => $("milestoneDialog").close();
    $("cancelMilestone").onclick = () => $("milestoneDialog").close();
    $("milestoneForm").onsubmit = (event) => {
      event.preventDefault();
      const current = project();
      const item = {
        id: state.editingMilestoneId || uid("ms"),
        title: $("msTitle").value.trim(),
        date: $("msDate").value,
      };
      if (!item.title || !item.date) return;
      const index = current.milestones.findIndex((entry) => entry.id === item.id);
      if (index >= 0) current.milestones[index] = item;
      else current.milestones.push(item);
      $("milestoneDialog").close();
      touch();
    };
    $("deleteMilestone").onclick = () => {
      const current = project();
      const item = current.milestones.find((entry) => entry.id === state.editingMilestoneId);
      if (!item || !window.confirm(`「${item.title}」を削除しますか？`)) return;
      current.milestones = current.milestones.filter((entry) => entry.id !== item.id);
      $("milestoneDialog").close();
      touch();
    };

    $("closeGenre").onclick = () => $("genreDialog").close();
    $("cancelGenre").onclick = () => $("genreDialog").close();
    $("genreForm").onsubmit = (event) => {
      event.preventDefault();
      const genre = {
        id: state.editingGenreId || uid("genre"),
        name: $("gName").value.trim(),
        color: safeColor($("gColor").value),
      };
      if (!genre.name) return;
      const index = state.studio.genres.findIndex((item) => item.id === genre.id);
      if (index >= 0) state.studio.genres[index] = genre;
      else state.studio.genres.push(genre);
      $("genreDialog").close();
      touch();
    };
    $("deleteGenre").onclick = () => {
      const genre = genreById(state.editingGenreId);
      if (!genre) return;
      const owned = state.studio.projects.reduce((sum, item) => (
        sum + item.tasks.filter((task) => task.genreId === genre.id).length
      ), 0);
      const message = owned
        ? `「${genre.name}」を外します。付いているタスクは ${owned} 件あり、ジャンル未設定になります。`
        : `「${genre.name}」を削除しますか？`;
      if (!window.confirm(message)) return;
      state.studio.genres = state.studio.genres.filter((item) => item.id !== genre.id);
      state.studio.projects.forEach((item) => {
        item.tasks.forEach((task) => {
          if (task.genreId === genre.id) task.genreId = "";
        });
      });
      if (state.genre === genre.id) state.genre = "all";
      $("genreDialog").close();
      touch();
    };

    $("closeProject").onclick = () => $("projectDialog").close();
    $("cancelProject").onclick = () => $("projectDialog").close();
    $("projectForm").onsubmit = (event) => {
      event.preventDefault();
      const name = $("pName").value.trim();
      if (!name) return;
      if (state.editingProjectId) {
        const current = state.studio.projects.find((item) => item.id === state.editingProjectId);
        if (current) current.name = name;
        $("projectDialog").close();
        touch();
        return;
      }
      const created = {
        id: uniqueProjectId(name),
        name,
        members: [],
        milestones: [],
        tasks: [],
      };
      state.studio.projects.push(created);
      $("projectDialog").close();
      state.studio.updated = toISODate(new Date());
      state.dirty = true;
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: state.studio }));
      go(created.id);
    };
    $("deleteProject").onclick = () => {
      const current = state.studio.projects.find((item) => item.id === state.editingProjectId);
      if (!current || !window.confirm(`「${current.name}」と中のタスクを削除しますか？`)) return;
      state.studio.projects = state.studio.projects.filter((item) => item.id !== current.id);
      $("projectDialog").close();
      state.studio.updated = toISODate(new Date());
      state.dirty = true;
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: state.studio }));
      go("");
    };

    $("dismissBanner").onclick = () => {
      localStorage.setItem(BANNER_KEY, "1");
      $("banner").classList.add("is-hidden");
    };
    $("openHelp").onclick = () => $("helpDialog").showModal();
    $("closeHelp").onclick = () => $("helpDialog").close();
    $("closeHelp2").onclick = () => $("helpDialog").close();
    $("openSettings").onclick = () => { fillSettings(); $("settingsDialog").showModal(); };
    $("closeSettings").onclick = () => $("settingsDialog").close();
    $("settingsForm").onsubmit = (event) => {
      event.preventDefault();
      const name = $("sStudio").value.trim();
      const changed = Boolean(name) && name !== state.studio.studio;
      if (changed && denyEdit()) return;
      if (changed) state.studio.studio = name;
      $("settingsDialog").close();
      if (changed) touch();
      else render();
    };
    $("loginGitHub").onclick = async () => {
      const client = await ensureClient();
      if (!client) {
        setMessage("データベースが未設定です。", true);
        return;
      }
      const { error } = await client.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: `${location.origin}${location.pathname}` },
      });
      if (error) setMessage(error.message, true);
    };
    $("logoutGitHub").onclick = async () => {
      const client = await ensureClient();
      if (client) await client.auth.signOut();
      state.session = null;
      state.canEdit = false;
      paintAuth();
      setMessage("ログアウトしました。");
    };
    $("downloadJson").onclick = () => downloadJson();
    $("importJson").onchange = async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file || denyEdit()) return;
      try {
        const text = await file.text();
        applyData(JSON.parse(text), text);
        touch();
        setSync("同期中");
      } catch (error) {
        setMessage(error.message, true);
      }
    };
    $("reloadFile").onclick = async () => {
      $("helpDialog").close();
      try {
        await load();
        setMessage("最新の内容に戻しました。");
      } catch (error) {
        setMessage(error.message, true);
      }
    };

    $("fProgress").oninput = () => { $("fProgressLabel").textContent = `${$("fProgress").value}%`; };
    $("fMilestone").onchange = () => {
      $("fEnd").disabled = $("fMilestone").checked;
      if ($("fMilestone").checked) $("fEnd").value = $("fStart").value;
    };
    $("fStart").onchange = () => {
      if ($("fMilestone").checked) $("fEnd").value = $("fStart").value;
    };
    $("closeTask").onclick = () => $("taskDialog").close();
    $("cancelTask").onclick = () => $("taskDialog").close();
    $("taskForm").onsubmit = (event) => {
      event.preventDefault();
      const task = readTaskForm();
      if (!task.title) return;
      const current = project();
      const index = current.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) current.tasks[index] = task;
      else current.tasks.push(task);
      $("taskDialog").close();
      touch();
    };
    $("deleteTask").onclick = () => {
      const current = project();
      const task = current.tasks.find((item) => item.id === state.editingTaskId);
      if (!task || !window.confirm(`「${task.title}」を削除しますか？`)) return;
      current.tasks = current.tasks.filter((item) => item.id !== task.id);
      $("taskDialog").close();
      touch();
    };

    $("closeMember").onclick = () => $("memberDialog").close();
    $("cancelMember").onclick = () => $("memberDialog").close();
    $("memberForm").onsubmit = (event) => {
      event.preventDefault();
      const member = {
        id: state.editingMemberId || uid("member"),
        name: $("mName").value.trim(),
        role: $("mRole").value.trim(),
        color: safeColor($("mColor").value),
      };
      if (!member.name) return;
      const current = project();
      const index = current.members.findIndex((item) => item.id === member.id);
      if (index >= 0) current.members[index] = member;
      else current.members.push(member);
      $("memberDialog").close();
      touch();
    };
    $("deleteMember").onclick = () => {
      const current = project();
      const member = memberById(state.editingMemberId);
      if (!member) return;
      const owned = current.tasks.filter((task) => task.memberId === member.id).length;
      const message = owned
        ? `「${member.name}」とタスク ${owned} 件を削除しますか？`
        : `「${member.name}」を削除しますか？`;
      if (!window.confirm(message)) return;
      current.members = current.members.filter((item) => item.id !== member.id);
      current.tasks = current.tasks.filter((task) => task.memberId !== member.id);
      if (state.member === member.id) state.member = "all";
      $("memberDialog").close();
      touch();
    };

    $("main").addEventListener("click", (event) => {
      const track = event.target.closest(".track");
      if (track && state.view === "chart" && !event.target.closest(".bar, .ms-mark, .handle")) {
        if (ignoreTrackClick) return;
        createTaskAt(track, event);
        return;
      }
      if (event.target.closest("#createProject")) {
        openProjectDialog(null);
        return;
      }
      const current = project();
      if (!current) return;
      const taskButton = event.target.closest("[data-edit-task]");
      if (taskButton) {
        openTaskDialog(current.tasks.find((task) => task.id === taskButton.dataset.editTask));
        return;
      }
      const memberButton = event.target.closest("[data-edit-member]");
      if (memberButton) {
        openMemberDialog(memberById(memberButton.dataset.editMember));
        return;
      }
      const genreButton = event.target.closest("[data-edit-genre]");
      if (genreButton) {
        openGenreDialog(genreById(genreButton.dataset.editGenre));
        return;
      }
      const milestoneButton = event.target.closest("[data-edit-milestone]");
      if (milestoneButton) {
        openMilestoneDialog(current.milestones.find((item) => item.id === milestoneButton.dataset.editMilestone));
      }
    });
    $("main").addEventListener("input", (event) => {
      const input = event.target.closest("[data-progress]");
      if (!input || !project()) return;
      if (denyEdit()) {
        render();
        return;
      }
      const task = project().tasks.find((item) => item.id === input.dataset.progress);
      if (!task) return;
      task.progress = Number(input.value);
      if (task.progress >= 100) task.status = "done";
      else if (task.status === "done") task.status = "doing";
      else if (task.status === "todo" && task.progress > 0) task.status = "doing";
      const pct = input.parentElement.querySelector(".pct");
      if (pct) pct.textContent = `${task.progress}%`;
      const statusCell = input.closest("tr")?.lastElementChild;
      if (statusCell) statusCell.textContent = STATUS[task.status] || task.status;
      markDirty();
      renderChrome();
    });
    $("main").addEventListener("pointerdown", (event) => {
      if (state.view !== "chart" || !project()) return;
      if (event.target.closest(".ms-mark")) bindMilestoneDrag(event);
      else if (event.target.closest(".bar")) bindChartDragOnce(event);
    });
    window.addEventListener("hashchange", () => render());
  }

  bind();
  load().catch((error) => {
    $("main").innerHTML = `<div class="empty">${esc(error.message)}<br>このフォルダで py -3 -m http.server 8765 を実行して開いてください。</div>`;
  });
})();
