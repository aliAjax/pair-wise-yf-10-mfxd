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
      frozen: false,
      frozenAt: null,
      frozenIssueId: null,
      frozenBeat: null,
      unfrozenAt: null,
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
  "GET /reinspections",
  "POST /reinspections/batch"
];

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

// 兼容历史数据：补齐复验台新增的集合与曲带冻结字段
function normalizeDb(db) {
  if (!Array.isArray(db.tunes)) db.tunes = [];
  if (!Array.isArray(db.sections)) db.sections = [];
  if (!Array.isArray(db.issues)) db.issues = [];
  if (!Array.isArray(db.reinspections)) db.reinspections = [];
  for (const tune of db.tunes) {
    if (tune.frozen === undefined) tune.frozen = false;
    if (tune.frozenAt === undefined) tune.frozenAt = null;
    if (tune.frozenIssueId === undefined) tune.frozenIssueId = null;
    if (tune.frozenBeat === undefined) tune.frozenBeat = null;
    if (tune.unfrozenAt === undefined) tune.unfrozenAt = null;
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
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) throw fail(404, "曲目不存在");
  return tune;
}

function findIssue(db, issueId) {
  const issue = db.issues.find((item) => item.id === issueId);
  if (!issue) throw fail(404, "问题不存在");
  return issue;
}

// 冻结期只允许登记复验（补孔复验是唯一解冻途径），其余变更一律拒绝
function assertTuneNotFrozen(tune) {
  if (tune.frozen) {
    throw fail(409, "曲带已冻结：需补孔后在更后拍号复奏无残留方可解除，冻结期间仅可登记复验");
  }
}

function holeSignature(hole) {
  return `${Number(hole.beat)}:${Number(hole.lane)}`;
}

function holeCount(record) {
  return new Set((record.residualHoles || []).map(holeSignature)).size;
}

function recordsOfIssue(db, issueId) {
  return db.reinspections
    .filter((item) => item.issueId === issueId)
    .slice()
    .sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
}

// 连续两次（与上一回合相比）残留点位未缩小，计数到 2 即冻结。
// 已无残留孔位（含补孔清除后）不算未缩小，连击清零，避免解冻后复查再次触发冻结。
function noShrinkStreak(records) {
  let streak = 0;
  for (let i = 1; i < records.length; i += 1) {
    const current = holeCount(records[i]);
    if (current === 0) {
      streak = 0;
    } else if (current < holeCount(records[i - 1])) {
      streak = 0;
    } else {
      streak += 1;
    }
  }
  return streak;
}

function tuneView(tune) {
  return {
    id: tune.id,
    frozen: Boolean(tune.frozen),
    frozenAt: tune.frozenAt || null,
    frozenIssueId: tune.frozenIssueId || null,
    frozenBeat: tune.frozenBeat ?? null,
    unfrozenAt: tune.unfrozenAt || null
  };
}

// 登记一条复验并联动冻结/解冻，返回新记录与曲带状态
function applyReinspection(db, issue, input) {
  const tune = findTune(db, issue.tuneId);
  const previous = recordsOfIssue(db, issue.id);
  const record = {
    id: makeId("reinspection"),
    issueId: issue.id,
    tuneId: issue.tuneId,
    round: previous.length + 1,
    beat: input.beat,
    residualHoles: input.residualHoles,
    conclusion: input.conclusion,
    patched: input.patched,
    createdAt: new Date().toISOString()
  };
  db.reinspections.push(record);

  let action = "recorded";
  const all = recordsOfIssue(db, issue.id);

  // 解冻优先：补孔 + 更后拍号 + 无残留，且复验的正是触发冻结的问题
  if (
    tune.frozen &&
    tune.frozenIssueId === issue.id &&
    record.patched &&
    record.residualHoles.length === 0 &&
    tune.frozenBeat !== null &&
    record.beat > tune.frozenBeat
  ) {
    tune.frozen = false;
    tune.unfrozenAt = record.createdAt;
    action = "unfrozen";
  } else if (!tune.frozen && noShrinkStreak(all) >= 2) {
    tune.frozen = true;
    tune.frozenAt = record.createdAt;
    tune.frozenIssueId = issue.id;
    tune.frozenBeat = record.beat;
    tune.unfrozenAt = null;
    action = "frozen";
  }

  return { record, tune, action };
}

// 校验单条复验录入（批量时用 indexLabel 标出第几条）
function parseReinspectionInput(db, rawIssueId, body, indexLabel = "") {
  const where = indexLabel ? `${indexLabel}：` : "";
  const issueId = rawIssueId ?? body.issueId;
  const missingFields = ["beat", "residualHoles", "conclusion"].filter(
    (field) => body[field] === undefined || body[field] === null || body[field] === ""
  );
  if (!issueId) missingFields.unshift("issueId");
  if (missingFields.length) throw fail(400, `${where}缺少字段：${missingFields.join(", ")}`);
  const issue = db.issues.find((item) => item.id === issueId);
  if (!issue) throw fail(400, `${where}问题不存在：${issueId}`);

  const beat = Number(body.beat);
  if (!Number.isFinite(beat)) throw fail(400, `${where}试奏拍号必须是数字`);

  if (!Array.isArray(body.residualHoles)) {
    throw fail(400, `${where}残留孔位必须是数组（无残留请传空数组）`);
  }
  const residualHoles = body.residualHoles.map((hole) => {
    if (!hole || typeof hole !== "object") throw fail(400, `${where}残留孔位格式应为 {beat, lane}`);
    const hBeat = Number(hole.beat);
    const hLane = Number(hole.lane);
    if (!Number.isFinite(hBeat) || !Number.isFinite(hLane)) {
      throw fail(400, `${where}残留孔位的 beat/lane 必须是数字`);
    }
    return { beat: hBeat, lane: hLane };
  });

  const conclusion = String(body.conclusion).trim();
  if (!conclusion) throw fail(400, `${where}缺少现场结论`);

  return {
    issue,
    beat,
    residualHoles,
    conclusion,
    patched: body.patched !== undefined ? Boolean(body.patched) : false
  };
}

// 历史问题无复验数据 -> unreinspected
function buildIssueReview(db, issue) {
  const records = recordsOfIssue(db, issue.id);
  const last = records.length ? records[records.length - 1] : null;
  const state = !last ? "unreinspected" : last.residualHoles.length === 0 ? "cleared" : "residual";
  return {
    reinspected: records.length > 0,
    reinspectionCount: records.length,
    reviewState: state,
    lastRound: last ? last.round : null,
    lastBeat: last ? last.beat : null,
    lastResidualHoles: last ? last.residualHoles : [],
    noShrinkStreak: noShrinkStreak(records)
  };
}

function withReview(db, issue) {
  return { ...issue, ...buildIssueReview(db, issue) };
}

function buildProgress(db, tuneId) {
  const tune = findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0,
    frozen: Boolean(tune.frozen),
    frozenAt: tune.frozenAt || null,
    frozenIssueId: tune.frozenIssueId || null
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
    const now = new Date().toISOString();
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      frozen: false,
      frozenAt: null,
      frozenIssueId: null,
      frozenBeat: null,
      unfrozenAt: null,
      createdAt: now
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
    const tune = findTune(db, tuneId);
    assertTuneNotFrozen(tune);
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
    assertTuneNotFrozen(findTune(db, section.tuneId));
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
      .map((issue) => withReview(db, issue));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    const tune = findTune(db, body.tuneId);
    assertTuneNotFrozen(tune);
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
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = findIssue(db, issueStatusMatch[1]);
    assertTuneNotFrozen(findTune(db, issue.tuneId));
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  const issueReinspectionsMatch = pathname.match(/^\/issues\/([^/]+)\/reinspections$/);
  if (issueReinspectionsMatch && req.method === "GET") {
    const issue = findIssue(db, issueReinspectionsMatch[1]);
    return send(res, 200, { data: recordsOfIssue(db, issue.id), review: buildIssueReview(db, issue) });
  }

  if (issueReinspectionsMatch && req.method === "POST") {
    const issue = findIssue(db, issueReinspectionsMatch[1]);
    const body = await parseBody(req);
    const input = parseReinspectionInput(db, issue.id, body);
    const result = applyReinspection(db, issue, input);
    await writeDb(db);
    return send(res, 201, { data: result.record, action: result.action, tune: tuneView(result.tune) });
  }

  if (req.method === "GET" && pathname === "/reinspections") {
    const tuneId = searchParams.get("tuneId");
    const issueId = searchParams.get("issueId");
    const list = db.reinspections
      .filter((item) => (!tuneId || item.tuneId === tuneId) && (!issueId || item.issueId === issueId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return send(res, 200, { data: list });
  }

  if (req.method === "POST" && pathname === "/reinspections/batch") {
    const body = await parseBody(req);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return send(res, 400, { error: "items 必须是非空数组" });
    }
    // 先整批校验：任一问题缺少残留孔位或现场结论，整批拒绝，不落盘
    const inputs = body.items.map((item, index) =>
      parseReinspectionInput(db, item && item.issueId, item || {}, `第${index + 1}条`)
    );
    const created = [];
    for (const input of inputs) {
      created.push(applyReinspection(db, input.issue, input));
    }
    await writeDb(db);
    const tunes = [];
    for (const result of created) {
      if (!tunes.some((item) => item.id === result.tune.id)) tunes.push(tuneView(result.tune));
    }
    return send(res, 201, {
      data: created.map((result) => result.record),
      count: created.length,
      actions: created.map((result) => result.action),
      tunes
    });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip reinspection bench running at http://127.0.0.1:${PORT}`);
});
