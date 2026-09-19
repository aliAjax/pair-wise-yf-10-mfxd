const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      freeze: freshFreeze(),
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  reinspections: []
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /issues/:id/reinspections",
  "POST /issues/:id/reinspections",
  "POST /reinspections/batch"
];

function freshFreeze() {
  return {
    frozen: false,
    frozenAt: null,
    triggerIssueId: null,
    triggerReinspectionId: null,
    freezeBeat: null,
    unfrozenAt: null,
    unfreezeReinspectionId: null
  };
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  return normalizeDb(db);
}

// 旧数据文件没有复验/冻结字段，读取时补齐，历史问题即按“未复验”处理
function normalizeDb(db) {
  if (!Array.isArray(db.reinspections)) db.reinspections = [];
  for (const tune of db.tunes || []) {
    if (!tune.freeze || typeof tune.freeze !== "object") tune.freeze = freshFreeze();
  }
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function findIssue(db, issueId) {
  const issue = db.issues.find((item) => item.id === issueId);
  if (!issue) {
    const error = new Error("问题不存在");
    error.status = 404;
    throw error;
  }
  return issue;
}

// 冻结期只允许复验登记（解除冻结的唯一途径），其余改动一律拒绝
function assertNotFrozen(db, tuneId) {
  const tune = findTune(db, tuneId);
  if (tune.freeze && tune.freeze.frozen) {
    const error = new Error("曲带已冻结：需对触发问题补孔后，在更后拍号复奏且无残留方可解除");
    error.status = 409;
    error.freeze = tune.freeze;
    throw error;
  }
}

function holeKey(hole) {
  return `${Number(hole.beat)}:${Number(hole.lane)}`;
}

// 残留孔位：必须显式提供数组，空数组表示“无残留”（与缺字段不同）
function normalizeResidualHoles(value) {
  if (value === undefined || value === null) {
    throw badRequest("缺少字段：residualHoles（无残留请提交空数组）");
  }
  if (!Array.isArray(value)) {
    throw badRequest("residualHoles 必须是孔位数组，每项包含 beat 与 lane（无残留请提交空数组）");
  }
  const seen = new Set();
  const list = [];
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw badRequest(`residualHoles[${index}] 必须是包含 beat 与 lane 的对象`);
    }
    const beat = Number(raw.beat);
    const lane = Number(raw.lane);
    if (!Number.isFinite(beat) || !Number.isFinite(lane)) {
      throw badRequest(`residualHoles[${index}] 的 beat、lane 必须是数字`);
    }
    const normalized = { beat, lane };
    const key = holeKey(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      list.push(normalized);
    }
  });
  return { list, set: seen };
}

// 校验单条复验申请，返回归一化字段；不合法直接抛 400
function validateReinspectionBody(body) {
  if (!body || typeof body !== "object") throw badRequest("请求体必须是对象");
  const replayBeat = Number(body.replayBeat);
  if (!Number.isFinite(replayBeat)) throw badRequest("缺少字段或字段非法：replayBeat（复奏拍号，数字）");
  if (body.conclusion === undefined || body.conclusion === null || String(body.conclusion).trim() === "") {
    throw badRequest("缺少字段：conclusion（现场结论）");
  }
  const patched = body.patched === undefined ? false : Boolean(body.patched);
  const { list } = normalizeResidualHoles(body.residualHoles);
  return {
    replayBeat,
    patched,
    residualHoles: list,
    conclusion: String(body.conclusion).trim(),
    note: body.note === undefined || body.note === null ? "" : String(body.note)
  };
}

function reinspectionsFor(db, issueId) {
  return db.reinspections
    .filter((item) => item.issueId === issueId)
    .sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
}

// 连续“未缩小”计数：新点位集合须是上一集合的严格子集才算缩小；
// 上一轮已无残留且仍无残留，不计失败；无残留后又冒出残留，计失败。
function computeNoShrinkStreak(history) {
  let streak = 0;
  let prev = null;
  for (const record of history) {
    const current = new Set(record.residualHoles.map(holeKey));
    if (prev !== null) {
      const bothEmpty = prev.size === 0 && current.size === 0;
      if (!bothEmpty) {
        const shrunk = current.size < prev.size && [...current].every((key) => prev.has(key));
        streak = shrunk ? 0 : streak + 1;
      }
    }
    prev = current;
  }
  return streak;
}

// 登记一次复验并驱动冻结/解除逻辑，返回记录与状态变化
function registerReinspection(db, issue, fields) {
  const tune = findTune(db, issue.tuneId);
  const historyBefore = reinspectionsFor(db, issue.id);
  const record = {
    id: makeId("reinspection"),
    issueId: issue.id,
    tuneId: issue.tuneId,
    round: historyBefore.length + 1,
    replayBeat: fields.replayBeat,
    patched: fields.patched,
    residualHoles: fields.residualHoles,
    conclusion: fields.conclusion,
    note: fields.note,
    createdAt: new Date().toISOString()
  };
  db.reinspections.push(record);

  const history = [...historyBefore, record];
  let action = "recorded";

  // 解除冻结：同一触发问题、补孔后、在更后拍号复奏、无残留
  if (
    tune.freeze.frozen &&
    tune.freeze.triggerIssueId === issue.id &&
    record.patched === true &&
    record.residualHoles.length === 0 &&
    record.replayBeat > tune.freeze.freezeBeat
  ) {
    tune.freeze.frozen = false;
    tune.freeze.unfrozenAt = record.createdAt;
    tune.freeze.unfreezeReinspectionId = record.id;
    action = "unfrozen";
  } else if (!tune.freeze.frozen) {
    const streak = computeNoShrinkStreak(history);
    if (streak >= 2) {
      tune.freeze.frozen = true;
      tune.freeze.frozenAt = record.createdAt;
      tune.freeze.triggerIssueId = issue.id;
      tune.freeze.triggerReinspectionId = record.id;
      tune.freeze.freezeBeat = record.replayBeat;
      action = "frozen";
    }
  }

  return { record, action, streak: computeNoShrinkStreak(history), freeze: tune.freeze };
}

// 由复验历史派生问题复验状态；无任何复验记录即“未复验”
function decorateIssue(db, issue) {
  const history = reinspectionsFor(db, issue.id);
  const last = history.length ? history[history.length - 1] : null;
  const verification = {
    state: last ? (last.residualHoles.length === 0 ? "no-residual" : "has-residual") : "unreinspected",
    reinspectionCount: history.length,
    lastRound: last ? last.round : null,
    lastReplayBeat: last ? last.replayBeat : null,
    lastPatched: last ? last.patched : null,
    lastResidualHoles: last ? last.residualHoles : null,
    lastConclusion: last ? last.conclusion : null,
    lastAt: last ? last.createdAt : null
  };
  return { ...issue, verification };
}

function buildProgress(db, tuneId) {
  const tune = findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  const decorated = issues.map((issue) => decorateIssue(db, issue));
  const tuneReinspections = db.reinspections.filter((item) => item.tuneId === tuneId);
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0,
    frozen: Boolean(tune.freeze.frozen),
    freeze: tune.freeze,
    totalReinspections: tuneReinspections.length,
    unreinspectedIssues: decorated.filter((item) => item.verification.state === "unreinspected").length,
    residualIssues: decorated.filter((item) => item.verification.state === "has-residual").length,
    noResidualIssues: decorated.filter((item) => item.verification.state === "no-residual").length
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-reinspection-bench", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      freeze: freshFreeze(),
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    assertNotFrozen(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || ""
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    assertNotFrozen(db, section.tuneId);
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues
      .filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status))
      .map((issue) => decorateIssue(db, issue));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    assertNotFrozen(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    await writeDb(db);
    return send(res, 201, { data: decorateIssue(db, issue) });
  }

  const issueReinspectionsMatch = pathname.match(/^\/issues\/([^/]+)\/reinspections$/);
  if (issueReinspectionsMatch && req.method === "GET") {
    const issue = findIssue(db, issueReinspectionsMatch[1]);
    return send(res, 200, {
      data: reinspectionsFor(db, issue.id),
      issue: decorateIssue(db, issue),
      freeze: findTune(db, issue.tuneId).freeze
    });
  }

  if (issueReinspectionsMatch && req.method === "POST") {
    const issue = findIssue(db, issueReinspectionsMatch[1]);
    // 冻结期仍允许登记复验——这是解除冻结的唯一途径
    const body = await parseBody(req);
    const fields = validateReinspectionBody(body);
    const result = registerReinspection(db, issue, fields);
    await writeDb(db);
    return send(res, 201, {
      data: result.record,
      action: result.action,
      noShrinkStreak: result.streak,
      issue: decorateIssue(db, issue),
      freeze: result.freeze
    });
  }

  // 批量复验：先整批校验，任一条缺残留孔位/现场结论或引用不存在问题，整批拒绝且不落盘
  if (req.method === "POST" && pathname === "/reinspections/batch") {
    const body = await parseBody(req);
    if (!body || !Array.isArray(body.entries) || body.entries.length === 0) {
      return send(res, 400, { error: "entries 必须是非空复验登记数组" });
    }

    const normalized = [];
    const rejected = [];
    body.entries.forEach((entry, index) => {
      try {
        if (!entry || typeof entry !== "object") throw badRequest("登记项必须是对象");
        if (entry.issueId === undefined || entry.issueId === null || String(entry.issueId).trim() === "") {
          throw badRequest("缺少字段：issueId");
        }
        const issue = db.issues.find((item) => item.id === String(entry.issueId).trim());
        if (!issue) throw badRequest("问题不存在");
        const fields = validateReinspectionBody(entry);
        normalized.push({ issue, fields });
      } catch (error) {
        rejected.push({ index, issueId: entry && entry.issueId, reason: error.message });
      }
    });

    if (rejected.length) {
      // 不调用 writeDb：原状态、进度与问题记录保持不变
      return send(res, 400, {
        error: "整批复验登记被拒绝，未写入任何数据",
        rejected,
        acceptedCount: 0
      });
    }

    const accepted = [];
    const actions = [];
    for (const { issue, fields } of normalized) {
      const result = registerReinspection(db, issue, fields);
      accepted.push(result.record);
      if (result.action !== "recorded") {
        actions.push({
          issueId: issue.id,
          reinspectionId: result.record.id,
          action: result.action,
          freeze: result.freeze
        });
      }
    }
    await writeDb(db);
    return send(res, 201, { data: accepted, acceptedCount: accepted.length, actions });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = findIssue(db, issueStatusMatch[1]);
    assertNotFrozen(db, issue.tuneId);
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    await writeDb(db);
    return send(res, 200, { data: decorateIssue(db, issue) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误", freeze: error.freeze })
  );
});

server.listen(PORT, () => {
  console.log(`Organ strip reinspection bench running at http://127.0.0.1:${PORT}`);
});
