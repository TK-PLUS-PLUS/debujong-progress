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
  const DRAFT_KEY = "debujong-gantt-draft-v1";
  const SETTINGS_KEY = "debujong-gantt-github-v1";
  const BANNER_KEY = "debujong-gantt-banner-v1";

  const state = {
    data: null,
    fileText: "",
    view: "chart",
    zoom: "week",
    status: "all",
    member: "all",
    query: "",
    dirty: false,
    editingTaskId: null,
    editingMemberId: null,
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

  function safeColor(color) {
    return /^#[0-9a-fA-F]{6}$/.test(color || "") ? color : "#c2412d";
  }

  function memberById(id) {
    return state.data.members.find((member) => member.id === id);
  }

  function visibleTasks() {
    const q = state.query.trim().toLowerCase();
    return state.data.tasks.filter((task) => {
      if (state.status !== "all" && task.status !== state.status) return false;
      if (state.member !== "all" && task.memberId !== state.member) return false;
      if (!q) return true;
      return `${task.title} ${task.notes || ""}`.toLowerCase().includes(q);
    });
  }

  function serialize(data) {
    return `${JSON.stringify({
      version: 1,
      project: data.project,
      updated: data.updated,
      members: data.members,
      tasks: data.tasks,
    }, null, 2)}\n`;
  }

  function touch() {
    state.data.updated = toISODate(new Date());
    state.dirty = true;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: state.data }));
    render();
  }

  function setMessage(text, isError) {
    const node = $("statusLine");
    node.textContent = text || "";
    node.classList.toggle("is-error", Boolean(isError));
  }

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSettings(extra) {
    const current = loadSettings();
    const next = {
      ...current,
      project: $("sProject").value.trim(),
      owner: $("sOwner").value.trim(),
      repo: $("sRepo").value.trim(),
      branch: $("sBranch").value.trim(),
      path: $("sPath").value.trim(),
      ...extra,
    };
    if ($("sRemember").checked) next.token = $("sToken").value.trim();
    else delete next.token;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  function fillSettings() {
    const saved = loadSettings();
    $("sProject").value = state.data?.project || saved.project || "デブ雀";
    $("sOwner").value = saved.owner || "TK-PLUS-PLUS";
    $("sRepo").value = saved.repo || "debujong-progress";
    $("sBranch").value = saved.branch || "main";
    $("sPath").value = saved.path || "schedule.json";
    $("sToken").value = saved.token || "";
    $("sRemember").checked = Boolean(saved.token);
    $("settingsMessage").textContent = "";
  }

  function githubConfig() {
    return {
      owner: $("sOwner").value.trim(),
      repo: $("sRepo").value.trim(),
      branch: $("sBranch").value.trim(),
      path: $("sPath").value.trim(),
      token: $("sToken").value.trim(),
    };
  }

  function contentsUrl(config) {
    const path = config.path.split("/").map(encodeURIComponent).join("/");
    const ref = encodeURIComponent(config.branch);
    return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path}?ref=${ref}`;
  }

  async function githubRequest(url, config, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = { message: text }; }
    }
    if (!response.ok) {
      const message = body?.message || `GitHub API ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
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
    return {
      start: startOfWeek(addDays(min, -7)),
      end: addDays(startOfWeek(addDays(max, 14)), 7),
      today,
    };
  }

  function renderChrome() {
    $("projectTitle").textContent = state.data.project || "デブ雀";
    document.title = `${state.data.project || "デブ雀"} 開発進捗`;
    const counts = Object.keys(STATUS).map((key) => {
      const count = state.data.tasks.filter((task) => task.status === key).length;
      return `${STATUS[key]} ${count}`;
    });
    $("updatedLabel").textContent = `${state.dirty ? "下書き " : ""}更新 ${state.data.updated || "—"} ・ ${counts.join(" / ")}`;

    $("statusChips").innerHTML = [`all`, ...Object.keys(STATUS)].map((key) => {
      const label = key === "all" ? "すべて" : STATUS[key];
      return `<button type="button" class="chip${state.status === key ? " is-on" : ""}" data-status="${key}">${label}</button>`;
    }).join("");

    const memberButtons = [`<button type="button" class="chip${state.member === "all" ? " is-on" : ""}" data-member="all">全員</button>`];
    state.data.members.forEach((member) => {
      memberButtons.push(`<button type="button" class="chip${state.member === member.id ? " is-on" : ""}" data-member="${esc(member.id)}"><i class="swatch" style="background:${safeColor(member.color)}"></i>${esc(member.name)}</button>`);
    });
    $("memberChips").innerHTML = memberButtons.join("");

    document.querySelectorAll("[data-zoom]").forEach((button) => {
      button.classList.toggle("is-on", button.dataset.zoom === state.zoom);
    });
    $("viewChart").classList.toggle("is-on", state.view === "chart");
    $("viewList").classList.toggle("is-on", state.view === "list");
    $("viewChart").setAttribute("aria-pressed", String(state.view === "chart"));
    $("viewList").setAttribute("aria-pressed", String(state.view === "list"));
  }

  function renderList(tasks) {
    if (!tasks.length) {
      $("main").innerHTML = `<div class="empty">該当するタスクがありません。</div>`;
      return;
    }
    const rows = tasks
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, "ja"))
      .map((task) => {
        const member = memberById(task.memberId);
        return `<tr>
          <td><i class="swatch" style="background:${safeColor(member?.color)}"></i>${esc(member?.name || "未定")}</td>
          <td><button type="button" class="linkish" data-edit-task="${esc(task.id)}">${esc(task.title)}</button></td>
          <td>${esc(task.start)}</td>
          <td>${esc(task.end)}</td>
          <td><input type="range" min="0" max="100" value="${Number(task.progress) || 0}" data-progress="${esc(task.id)}" aria-label="${esc(task.title)}の進捗"><span class="pct">${Number(task.progress) || 0}%</span></td>
          <td>${esc(STATUS[task.status] || task.status)}</td>
        </tr>`;
      }).join("");
    $("main").innerHTML = `<table class="list"><thead><tr><th>担当</th><th>タスク</th><th>開始</th><th>終了</th><th>進捗</th><th>状態</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderChart(tasks) {
    const dayWidth = ZOOM_WIDTH[state.zoom];
    const allForRange = state.data.tasks.length ? state.data.tasks : tasks;
    const range = rangeFor(allForRange);
    const totalDays = Math.max(1, daysBetween(range.start, range.end));
    const timelineWidth = totalDays * dayWidth;
    const members = state.data.members.filter((member) => state.member === "all" || member.id === state.member);

    const months = [];
    const ticks = [];
    const weekends = [];
    for (let i = 0; i < totalDays; i += 1) {
      const date = addDays(range.start, i);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      const last = months[months.length - 1];
      if (!last || last.key !== key) months.push({ key, index: i, label: `${date.getFullYear()}/${date.getMonth() + 1}` });
      else last.span = i - last.index + 1;
      if (!months[months.length - 1].span) months[months.length - 1].span = 1;

      const weekday = date.getDay();
      if (weekday === 0 || weekday === 6) weekends.push(i);
      const showTick = state.zoom === "day" || (state.zoom === "week" && weekday === 1) || (state.zoom === "month" && date.getDate() === 1);
      if (showTick) {
        const label = state.zoom === "month"
          ? `${date.getMonth() + 1}/${date.getDate()}`
          : `${date.getMonth() + 1}/${date.getDate()}`;
        ticks.push(`<span class="tick-label" style="left:${i * dayWidth}px;width:${Math.max(dayWidth, 36)}px">${label}</span>`);
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

    const rows = members.map((member) => {
      const mine = tasks.filter((task) => task.memberId === member.id);
      const packed = pack(mine);
      const height = Math.max(52, packed.lanes * 36 + 16);
      const bars = packed.items.map(({ task, lane }) => {
        const start = parseISODate(task.start);
        const end = parseISODate(task.milestone ? task.start : task.end);
        const left = daysBetween(range.start, start) * dayWidth;
        const width = Math.max(dayWidth, (daysBetween(start, end) + 1) * dayWidth);
        const progress = Math.min(100, Math.max(0, Number(task.progress) || 0));
        if (task.milestone) {
          return `<button type="button" class="bar is-milestone is-${esc(task.status)}" data-task="${esc(task.id)}" data-mode="move" style="left:${left}px;top:${12 + lane * 36}px;--bar:${safeColor(member.color)};background:${safeColor(member.color)}" title="${esc(task.title)} ${esc(task.start)}"><span class="bar-label">${esc(task.title)}</span></button>`;
        }
        return `<button type="button" class="bar is-${esc(task.status)}" data-task="${esc(task.id)}" style="left:${left}px;top:${10 + lane * 36}px;width:${width}px;background:color-mix(in srgb, ${safeColor(member.color)} 35%, white)" title="${esc(task.title)} ${esc(task.start)}–${esc(task.end)} ${progress}%">
          <span class="bar-fill" style="width:${progress}%;--bar:${safeColor(member.color)}"></span>
          <span class="handle w" data-mode="start"></span>
          <span class="handle e" data-mode="end"></span>
          <span class="bar-label">${esc(task.title)}</span>
        </button>`;
      }).join("");
      const note = mine.length ? `${mine.length}件` : "タスクなし";
      return `<div class="row">
        <div class="lane"><button type="button" class="lane-btn" data-edit-member="${esc(member.id)}"><strong><i class="swatch" style="background:${safeColor(member.color)}"></i>${esc(member.name)}</strong><span>${esc(member.role || "")} ・ ${note}</span></button></div>
        <div class="track" style="width:${timelineWidth}px;height:${height}px">${weekendHtml}${bars}</div>
      </div>`;
    }).join("");

    $("main").innerHTML = `<div class="gantt-scroll" id="ganttScroll"><div class="gantt-canvas" style="width:${timelineWidth + 200}px">
      <div class="gantt-header">
        <div class="lane">メンバー</div>
        <div class="time-head" style="width:${timelineWidth}px">${monthHtml}${ticks.join("")}${todayMark}</div>
      </div>
      ${rows || `<div class="empty">メンバーがいません。</div>`}
      ${todayLine}
    </div></div>`;

    const scroller = $("ganttScroll");
    if (todayIndex >= 0) scroller.scrollLeft = Math.max(0, todayIndex * dayWidth - scroller.clientWidth * 0.35);
  }

  function render() {
    renderChrome();
    const tasks = visibleTasks();
    if (state.view === "list") renderList(tasks);
    else renderChart(tasks);
  }

  function openTaskDialog(task) {
    state.editingTaskId = task?.id || null;
    $("taskDialogTitle").textContent = task ? "タスクを編集" : "タスクを追加";
    $("deleteTask").hidden = !task;
    $("fTitle").value = task?.title || "";
    $("fMember").innerHTML = state.data.members.map((member) => (
      `<option value="${esc(member.id)}">${esc(member.name)}</option>`
    )).join("");
    $("fMember").value = task?.memberId || (state.member !== "all" ? state.member : state.data.members[0]?.id || "");
    $("fStatus").innerHTML = Object.entries(STATUS).map(([key, label]) => `<option value="${key}">${label}</option>`).join("");
    $("fStatus").value = task?.status || "doing";
    $("fProgress").value = String(task?.progress ?? (task ? 0 : 0));
    $("fProgressLabel").textContent = `${$("fProgress").value}%`;
    const today = toISODate(new Date());
    $("fStart").value = task?.start || today;
    $("fEnd").value = task?.end || toISODate(addDays(new Date(), 6));
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
    state.editingMemberId = member?.id || null;
    $("memberDialogTitle").textContent = member ? "メンバーを編集" : "メンバーを追加";
    $("deleteMember").hidden = !member;
    $("mName").value = member?.name || "";
    $("mRole").value = member?.role || "";
    $("mColor").value = safeColor(member?.color || COLORS[state.data.members.length % COLORS.length]);
    $("memberDialog").showModal();
    $("mName").focus();
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

  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  async function saveToGitHub() {
    if (!$("settingsDialog").open) fillSettings();
    const config = githubConfig();
    if (!config.token) {
      if (!$("settingsDialog").open) $("settingsDialog").showModal();
      $("settingsMessage").textContent = "トークンを入れて、もう一度「GitHubに保存」を押してください。";
      return;
    }
    $("settingsMessage").textContent = "保存しています…";
    try {
      let sha;
      try {
        const current = await githubRequest(contentsUrl(config), config);
        sha = current.sha;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      state.data.project = $("sProject").value.trim() || state.data.project;
      state.data.updated = toISODate(new Date());
      const content = encodeBase64(serialize(state.data));
      const body = {
        message: "ガントチャートの進捗を更新",
        content,
        branch: config.branch,
      };
      if (sha) body.sha = sha;
      await githubRequest(contentsUrl(config).split("?")[0], config, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      state.fileText = serialize(state.data);
      state.dirty = false;
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: state.data }));
      saveSettings();
      $("settingsMessage").textContent = "保存しました。Pages を有効にしていれば、しばらくすると公開ページにも反映されます。";
      render();
    } catch (error) {
      $("settingsMessage").textContent = `保存できませんでした。${error.message}`;
    }
  }

  async function testGitHub() {
    const config = githubConfig();
    saveSettings();
    if (!config.token) {
      $("settingsMessage").textContent = "トークンが空です。";
      return;
    }
    try {
      const file = await githubRequest(contentsUrl(config), config);
      $("settingsMessage").textContent = `接続できました。${config.path} の更新を確認しています（${file.sha.slice(0, 7)}）。`;
    } catch (error) {
      $("settingsMessage").textContent = error.status === 404
        ? "接続できましたが、指定ブランチにファイルがまだありません。保存すると作成されます。"
        : `接続できませんでした。${error.message}`;
    }
  }

  function downloadJson() {
    state.data.project = $("sProject").value.trim() || state.data.project;
    const blob = new Blob([serialize(state.data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "schedule.json";
    link.click();
    URL.revokeObjectURL(url);
    saveSettings();
  }

  function applyData(data, fileText) {
    if (!data || !Array.isArray(data.members) || !Array.isArray(data.tasks)) {
      throw new Error("members と tasks が必要です。");
    }
    state.data = data;
    state.fileText = fileText || serialize(data);
    state.dirty = false;
    $("banner").classList.toggle("is-hidden", localStorage.getItem(BANNER_KEY) === "1");
    render();
  }

  async function load() {
    const response = await fetch("./schedule.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`schedule.json を読めませんでした (${response.status})`);
    const text = await response.text();
    const data = JSON.parse(text);
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { draft = null; }
    applyData(data, text);
    if (draft?.data && JSON.stringify(draft.data) !== JSON.stringify(data)) {
      const useDraft = window.confirm("このブラウザに未共有の下書きがあります。下書きを開きますか？");
      if (useDraft) {
        state.data = draft.data;
        state.dirty = true;
        render();
      }
    }
  }

  function bind() {
    $("viewChart").onclick = () => { state.view = "chart"; render(); };
    $("viewList").onclick = () => { state.view = "list"; render(); };
    document.querySelectorAll("[data-zoom]").forEach((button) => {
      button.onclick = () => { state.zoom = button.dataset.zoom; render(); };
    });
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
    $("addTask").onclick = () => {
      if (!state.data.members.length) {
        setMessage("先にメンバーを追加してください。", true);
        return;
      }
      openTaskDialog(null);
    };
    $("addMember").onclick = () => openMemberDialog(null);
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
      const name = $("sProject").value.trim();
      const changed = Boolean(name) && name !== state.data.project;
      if (changed) state.data.project = name;
      saveSettings();
      $("settingsDialog").close();
      if (changed) touch();
      else renderChrome();
    };
    $("saveGitHub").onclick = () => saveToGitHub();
    $("testGitHub").onclick = () => testGitHub();
    $("downloadJson").onclick = () => downloadJson();
    $("importJson").onchange = async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        applyData(JSON.parse(text), text);
        touch();
        setMessage(`${file.name} を読み込みました。共有するには保存してください。`);
      } catch (error) {
        setMessage(error.message, true);
      }
    };
    $("reloadFile").onclick = async () => {
      localStorage.removeItem(DRAFT_KEY);
      $("helpDialog").close();
      try {
        await load();
        setMessage("schedule.json の内容に戻しました。");
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
      const index = state.data.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) state.data.tasks[index] = task;
      else state.data.tasks.push(task);
      $("taskDialog").close();
      touch();
    };
    $("deleteTask").onclick = () => {
      const task = state.data.tasks.find((item) => item.id === state.editingTaskId);
      if (!task || !window.confirm(`「${task.title}」を削除しますか？`)) return;
      state.data.tasks = state.data.tasks.filter((item) => item.id !== task.id);
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
      const index = state.data.members.findIndex((item) => item.id === member.id);
      if (index >= 0) state.data.members[index] = member;
      else state.data.members.push(member);
      $("memberDialog").close();
      touch();
    };
    $("deleteMember").onclick = () => {
      const member = memberById(state.editingMemberId);
      if (!member) return;
      const owned = state.data.tasks.filter((task) => task.memberId === member.id).length;
      const message = owned
        ? `「${member.name}」とタスク ${owned} 件を削除しますか？`
        : `「${member.name}」を削除しますか？`;
      if (!window.confirm(message)) return;
      state.data.members = state.data.members.filter((item) => item.id !== member.id);
      state.data.tasks = state.data.tasks.filter((task) => task.memberId !== member.id);
      if (state.member === member.id) state.member = "all";
      $("memberDialog").close();
      touch();
    };

    $("main").addEventListener("click", (event) => {
      const taskButton = event.target.closest("[data-edit-task]");
      if (taskButton) {
        openTaskDialog(state.data.tasks.find((task) => task.id === taskButton.dataset.editTask));
        return;
      }
      const memberButton = event.target.closest("[data-edit-member]");
      if (memberButton) openMemberDialog(memberById(memberButton.dataset.editMember));
    });
    $("main").addEventListener("input", (event) => {
      const input = event.target.closest("[data-progress]");
      if (!input) return;
      const task = state.data.tasks.find((item) => item.id === input.dataset.progress);
      if (!task) return;
      task.progress = Number(input.value);
      if (task.progress >= 100) task.status = "done";
      else if (task.status === "done") task.status = "doing";
      else if (task.status === "todo" && task.progress > 0) task.status = "doing";
      const pct = input.parentElement.querySelector(".pct");
      if (pct) pct.textContent = `${task.progress}%`;
      const statusCell = input.closest("tr")?.lastElementChild;
      if (statusCell) statusCell.textContent = STATUS[task.status] || task.status;
      state.data.updated = toISODate(new Date());
      state.dirty = true;
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: state.data }));
      renderChrome();
    });
    $("main").addEventListener("pointerdown", (event) => {
      if (state.view === "chart" && event.target.closest(".bar")) bindChartDragOnce(event);
    });
  }

  function bindChartDragOnce(event) {
    const bar = event.target.closest(".bar");
    const task = state.data.tasks.find((item) => item.id === bar.dataset.task);
    if (!task) return;
    const mode = event.target.dataset.mode || "move";
    if (task.milestone && mode !== "move") return;
    if (event.button !== 0) return;
    const originX = event.clientX;
    const snapshot = { start: task.start, end: task.end };
    const rangeStart = rangeFor(state.data.tasks).start;
    let moved = false;
    const move = (ev) => {
      const delta = Math.round((ev.clientX - originX) / ZOOM_WIDTH[state.zoom]);
      if (Math.abs(ev.clientX - originX) > 4) moved = true;
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
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const changed = task.start !== snapshot.start || task.end !== snapshot.end;
      if (changed) touch();
      else if (!moved) openTaskDialog(task);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  bind();
  load().catch((error) => {
    $("main").innerHTML = `<div class="empty">${esc(error.message)}<br>このフォルダで py -3 -m http.server 8765 を実行して開いてください。</div>`;
  });
})();
