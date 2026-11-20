const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const CHANNEL_TYPE = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
};

const state = {
  preview: null,
  selectedChannels: new Set(),
  jobId: null,
  running: false,
  startedAt: 0,
  requests: 0,
  rateLimits: 0,
  messages: 0,
  lines: 0,
};

const logEl = () => $("#log");

function stamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function logLine(message, level = "info") {
  const box = logEl();
  box.querySelector(".log-empty")?.remove();
  const line = document.createElement("div");
  line.className = `log-line ${level}`;

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = stamp();

  const text = document.createElement("span");
  text.className = "log-text";
  text.textContent = message;

  line.append(time, text);
  box.append(line);

  state.lines += 1;
  $("#logCount").textContent = `${state.lines} line${state.lines === 1 ? "" : "s"}`;
  box.scrollTop = box.scrollHeight;
}

function setStatus(kind, label) {
  const pill = $("#statusPill");
  pill.className = `status ${kind}`;
  pill.innerHTML = `<span class="status-dot"></span>${label}`;
}

function setProgress(percent, step) {
  $("#progressFill").style.width = `${percent}%`;
  $("#percentLabel").textContent = `${percent}%`;
  if (step) $("#stepLabel").textContent = step;
}

function setRunning(running) {
  state.running = running;
  for (const el of $$("input, button")) {
    if (el.id === "peekToken" || el.id === "guideBtn" || el.id === "guideClose") continue;
    if (el.classList.contains("tab")) continue;
    if (el.id === "cancelBtn") {
      el.disabled = !running;
      continue;
    }
    if (el.id === "clearLog") continue;
    el.disabled = running;
  }
  $("#startBtn").disabled = running || !state.preview;
  $("#cancelBtn").disabled = !running;
}

function elapsedText() {
  if (!state.startedAt) return "0s";
  const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function tick() {
  if (state.running) $("#statTime").textContent = elapsedText();
}

function previewBody() {
  return {
    token: $("#token").value.trim(),
    sourceId: $("#sourceId").value.trim(),
    targetId: $("#targetId").value.trim() || undefined,
  };
}

async function analyze() {
  const body = previewBody();
  if (!body.token) return logLine("paste a token first", "error");
  if (!/^\d{16,20}$/.test(body.sourceId)) return logLine("source id looks wrong", "error");
  if (body.targetId && !/^\d{16,20}$/.test(body.targetId)) {
    return logLine("target id looks wrong", "error");
  }

  $("#analyzeBtn").disabled = true;
  $("#analyzeHint").textContent = "Reading the source server…";
  logLine("analyzing source…", "muted");

  try {
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    state.preview = data;
    renderPreview(data);
    logLine(`source "${data.guild.name}" loaded`, "ok");
    if (data.target) {
      if (data.target.error) logLine(`target: ${data.target.error}`, "error");
      else if (data.target.canAdmin) logLine(`target "${data.target.name}" — admin ok`, "ok");
      else logLine(`no administrator in target "${data.target.name}"`, "error");
    }
    $("#analyzeHint").textContent = "Change anything below, then start the clone.";
  } catch (error) {
    logLine(error.message, "error");
    $("#analyzeHint").textContent = "Analyze failed. Check the token and ids.";
  } finally {
    $("#analyzeBtn").disabled = false;
  }
}

function renderPreview(data) {
  $("#sourceCard").classList.remove("hidden");
  $("#guildName").textContent = data.guild.name;
  $("#guildId").textContent = data.guild.id;
  $("#guildDesc").textContent = data.guild.description || "";

  const icon = $("#guildIcon");
  if (data.guild.icon) {
    icon.src = data.guild.icon;
    icon.style.visibility = "visible";
  } else {
    icon.removeAttribute("src");
    icon.style.visibility = "hidden";
  }

  const categories = data.channels.filter((c) => c.type === CHANNEL_TYPE.category).length;
  const counts = [
    ["roles", data.roles.length],
    ["channels", data.channels.length - categories],
    ["categories", categories],
    ["emojis", data.emojis.length],
  ];
  $("#sourceStats").innerHTML = counts
    .map(
      ([label, value]) =>
        `<div><strong>${value}</strong><span>${label}</span></div>`,
    )
    .join("");
  $("#sourceCounts").textContent = data.onboarding.exists
    ? `onboarding · ${data.onboarding.prompts} prompts`
    : "no onboarding";

  const warn = $("#targetWarn");
  if (data.target?.error) {
    warn.className = "warn-banner";
    warn.textContent = `Target unreachable: ${data.target.error}`;
  } else if (data.target && !data.target.canAdmin) {
    warn.className = "warn-banner";
    warn.textContent = `This token has no administrator role in "${data.target.name}". The clone will fail at step one.`;
  } else if (data.target) {
    warn.className = "warn-banner good";
    warn.textContent = `Target "${data.target.name}" is ready. Tier ${data.target.premium_tier}.`;
  } else {
    warn.className = "warn-banner hidden";
  }

  renderChannels(data.channels);
  $("#startBtn").disabled = !data.target?.canAdmin;
  $("#startHint").textContent = data.target?.canAdmin
    ? "Ready when you are."
    : "Add the target id and make sure the token is admin there.";
}

function renderChannels(channels) {
  const list = $("#channelList");
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const eligible = channels
    .filter((c) => c.type === CHANNEL_TYPE.text || c.type === CHANNEL_TYPE.announcement)
    .sort((a, b) => {
      const pa = a.parent_id ? byId.get(a.parent_id)?.position ?? 0 : -1;
      const pb = b.parent_id ? byId.get(b.parent_id)?.position ?? 0 : -1;
      return pa - pb || a.position - b.position;
    });

  if (!eligible.length) {
    list.innerHTML = '<p class="dim small">No text channels in this server.</p>';
    return;
  }

  state.selectedChannels.clear();
  list.innerHTML = eligible
    .map((channel) => {
      const parent = channel.parent_id ? byId.get(channel.parent_id)?.name ?? "" : "";
      return `
        <label class="chan">
          <input type="checkbox" value="${channel.id}" />
          <span class="hash">#</span>
          <span>${escapeHtml(channel.name)}</span>
          ${parent ? `<span class="cat">${escapeHtml(parent)}</span>` : ""}
        </label>`;
    })
    .join("");

  for (const box of list.querySelectorAll('input[type="checkbox"]')) {
    box.addEventListener("change", () => {
      if (box.checked) state.selectedChannels.add(box.value);
      else state.selectedChannels.delete(box.value);
      updateChannelCount();
    });
  }
  updateChannelCount();
}

function updateChannelCount() {
  $("#channelCount").textContent = `${state.selectedChannels.size} selected`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

function options() {
  const checked = (id) => $(id).checked;
  return {
    cloneName: checked("#opt-name"),
    cloneIcon: checked("#opt-icon"),
    cloneDescription: checked("#opt-description"),
    cloneRoles: checked("#opt-roles"),
    cloneEmojis: checked("#opt-emojis"),
    cloneCategories: checked("#opt-categories"),
    cloneChannels: checked("#opt-channels"),
    cloneOnboarding: checked("#opt-onboarding"),
    cloneStickers: checked("#opt-stickers"),
    cloneSoundboard: checked("#opt-soundboard"),
    cloneSettings: checked("#opt-settings"),
    cloneWelcome: checked("#opt-welcome"),
    cloneWebhooks: checked("#opt-webhooks"),
    cloneInvites: checked("#opt-invites"),
    cloneEvents: checked("#opt-events"),
    cloneAutomod: checked("#opt-automod"),
    cloneBans: checked("#opt-bans"),
    clonePins: checked("#opt-pins"),
    cloneMessages: checked("#opt-messages"),
    messageChannels: Array.from(state.selectedChannels),
    messageLimit: Number($("#messageLimit").value) || 50,
    webhookCount: Number($("#webhookCount").value) || 3,
    parallelChannels: Number($("#parallelChannels").value) || 3,
    rateLimitWaitSeconds: Number($("#rateLimitWait").value) || 60,
    deleteWebhooks: true,
    deleteExisting: checked("#opt-delete"),
  };
}

async function start() {
  if (state.running) return;
  const body = previewBody();
  if (!body.token) return logLine("token is missing", "error");
  if (!/^\d{16,20}$/.test(body.sourceId)) return logLine("source id is missing", "error");
  if (!/^\d{16,20}$/.test(body.targetId || "")) return logLine("target id is missing", "error");

  const opts = options();
  if (opts.deleteExisting) {
    const ok = window.confirm(
      "Wipe the target server first?\n\nEvery channel, non-managed role and emoji will be deleted. There is no undo.",
    );
    if (!ok) return;
  }
  if (opts.cloneMessages && opts.messageChannels.length === 0) {
    return logLine("pick at least one channel for messages", "error");
  }
  if (opts.clonePins && !opts.cloneMessages) {
    logLine("pins only travel with messages — enable Messages to clone them", "warn");
  }

  logEl().innerHTML = "";
  state.lines = 0;
  $("#logCount").textContent = "0 lines";
  setProgress(0, "starting");
  setStatus("running", "running");
  setRunning(true);
  state.startedAt = Date.now();
  state.requests = 0;
  state.rateLimits = 0;
  state.messages = 0;
  $("#statRequests").textContent = "0";
  $("#statLimits").textContent = "0";
  $("#statMessages").textContent = "0";

  try {
    const res = await fetch("/api/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, options: opts }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.jobId = data.jobId;
    listen(data.jobId);
  } catch (error) {
    logLine(error.message, "error");
    setStatus("error", "failed");
    setRunning(false);
  }
}

function listen(jobId) {
  const source = new EventSource(`/api/stream/${jobId}`);

  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEvent(payload);
  };

  source.onerror = () => {
    source.close();
    if (state.running) {
      logLine("stream closed", "warn");
      setRunning(false);
      setStatus("error", "disconnected");
    }
  };
}

function handleEvent(event) {
  switch (event.type) {
    case "log":
      logLine(event.message, event.level);
      break;
    case "progress":
      setProgress(event.percent, event.step);
      break;
    case "ratelimit":
      state.rateLimits += 1;
      $("#statLimits").textContent = String(state.rateLimits);
      logLine(event.message, "rate");
      break;
    case "stats":
      state.requests = Math.max(state.requests, event.requests ?? 0);
      $("#statRequests").textContent = String(state.requests);
      break;
    case "done": {
      const summary = event.summary || {};
      state.messages = summary.messages ?? state.messages;
      $("#statMessages").textContent = String(state.messages);
      setProgress(100, "complete");
      setStatus("done", "done");
      setRunning(false);
      logLine("clone finished", "ok");
      if (summary.roles != null) {
        logLine(
          `${summary.roles} roles · ${summary.categories} categories · ${summary.channels} channels · ${summary.emojis} emojis · ${summary.messages} messages`,
          "muted",
        );
      }
      break;
    }
    case "error":
      logLine(event.message, "error");
      setStatus("error", "failed");
      setRunning(false);
      break;
    default:
      break;
  }
}

async function cancel() {
  if (!state.jobId) return;
  logLine("cancelling…", "warn");
  try {
    await fetch(`/api/job/${state.jobId}/cancel`, { method: "POST" });
  } catch {
    /* the stream will report the rest */
  }
}

const GUIDE = {
  windows: `
    <h3>What you need</h3>
    <p>Node.js 18 or newer, and the folder this app came in. Nothing else, no npm install.</p>
    <h3>Install Node</h3>
    <ol>
      <li>Download the LTS installer from <code>nodejs.org</code> and run it.</li>
      <li>Close and reopen PowerShell so <code>node</code> is on the path.</li>
      <li>Check it: <code>node -v</code> should print v18 or higher.</li>
    </ol>
    <h3>Run it</h3>
    <p>Double-click <code>axcloner.bat</code>. It checks Node, clears a stuck port if you say so, opens the browser and starts the server.</p>
    <p>Manually, if you prefer a terminal:</p>
    <pre><code>cd C:\\path\\to\\axcloner
node server.js</code></pre>
    <p>Open <code>http://localhost:4080</code> in your browser. Keep the window open while you clone.</p>
    <div class="callout">If port 4080 is taken, start with a different one: <code>set PORT=4090 &amp;&amp; node server.js</code></div>
  `,
  linux: `
    <h3>Node 18+</h3>
    <p>Most distros ship an older Node in their repos. Check first:</p>
    <pre><code>node -v</code></pre>
    <p>If it is below v18, install from NodeSource:</p>
    <pre><code>curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs</code></pre>
    <p>On a distro that is not Debian based, use nvm:</p>
    <pre><code>curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20</code></pre>
    <h3>Run it</h3>
    <pre><code>cd ~/axcloner
chmod +x axcloner.sh
./axcloner.sh</code></pre>
    <p>The launcher verifies Node, offers to free port 4080 if something holds it, opens the browser and runs the server. Manual start still works:</p>
    <pre><code>node server.js</code></pre>
    <p>Then open <code>http://localhost:4080</code>.</p>
    <div class="callout">Running on a remote box? Tunnel the port instead of exposing it: <code>ssh -L 4080:localhost:4080 user@host</code></div>
  `,
  termux: `
    <h3>Install</h3>
    <pre><code>pkg update -y &amp;&amp; pkg upgrade -y
pkg install -y nodejs</code></pre>
    <p>Termux ships a current Node, so nothing else is needed.</p>
    <h3>Run it</h3>
    <pre><code>cd ~/axcloner
node server.js</code></pre>
    <p>Open the browser on the phone:</p>
    <pre><code>termux-open-url http://localhost:4080</code></pre>
    <div class="callout">Disable battery optimization for Termux in Android settings, or the process gets killed when the screen locks mid-run.</div>
  `,
  usage: `
    <h3>Get the token</h3>
    <p>In the Discord client press <code>Ctrl+Shift+I</code>, open the Network tab, click any request to <code>discord.com/api</code> and copy the <code>authorization</code> request header. That value is the token. Treat it like a password.</p>
    <h3>Fill the form</h3>
    <ol>
      <li>Paste the token.</li>
      <li>Source server id: the server you are copying. You only need to be a member, no admin.</li>
      <li>Target server id: where it lands. The token account needs Administrator there.</li>
      <li>Hit <em>Analyze source</em>. It reads without writing anything.</li>
    </ol>
    <h3>Pick and run</h3>
    <p>Tick the parts you want. If you enable messages, choose the channels and how far back to go. Enable <em>Wipe target first</em> only when you want the target emptied. Then start the clone and watch the console.</p>
    <div class="callout">Onboarding only copies if the target already has Community enabled. Everything else is independent, so a failed onboarding never stops the run.</div>
  `,
};

function openGuide(tab = "windows") {
  $("#guideModal").classList.remove("hidden");
  switchTab(tab);
}

function switchTab(name) {
  for (const tab of $$(".tab")) tab.classList.toggle("active", tab.dataset.tab === name);
  $("#guideBody").innerHTML = GUIDE[name] ?? GUIDE.usage;
}

function init() {
  $("#analyzeBtn").addEventListener("click", analyze);
  $("#startBtn").addEventListener("click", start);
  $("#cancelBtn").addEventListener("click", cancel);

  $("#peekToken").addEventListener("click", () => {
    const input = $("#token");
    input.type = input.type === "password" ? "text" : "password";
  });

  $("#clearLog").addEventListener("click", () => {
    logEl().innerHTML = '<div class="log-empty">Console cleared.</div>';
    state.lines = 0;
    $("#logCount").textContent = "0 lines";
  });

  $("#opt-messages").addEventListener("change", (event) => {
    $("#messagesCard").classList.toggle("hidden", !event.target.checked);
  });

  $("#selectAll").addEventListener("click", () => {
    for (const box of $$(".opt-check")) box.checked = true;
    $("#messagesCard").classList.remove("hidden");
  });
  $("#selectNone").addEventListener("click", () => {
    for (const box of $$(".opt-check")) box.checked = false;
    $("#messagesCard").classList.add("hidden");
  });

  $("#chanAll").addEventListener("click", () => {
    for (const box of $$('#channelList input[type="checkbox"]')) {
      box.checked = true;
      state.selectedChannels.add(box.value);
    }
    updateChannelCount();
  });
  $("#chanNone").addEventListener("click", () => {
    for (const box of $$('#channelList input[type="checkbox"]')) box.checked = false;
    state.selectedChannels.clear();
    updateChannelCount();
  });

  $("#guideBtn").addEventListener("click", () => openGuide());
  $("#guideClose").addEventListener("click", () => $("#guideModal").classList.add("hidden"));
  $("#guideModal").addEventListener("click", (event) => {
    if (event.target.id === "guideModal") $("#guideModal").classList.add("hidden");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $("#guideModal").classList.add("hidden");
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !state.running) start();
  });
  for (const tab of $$(".tab")) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  }

  setInterval(tick, 1000);
  logEl().innerHTML = '<div class="log-empty">Waiting for a run.</div>';
  setStatus("", "idle");
}

init();
