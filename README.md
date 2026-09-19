# 手摇风琴纸带补孔复验台

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题与补孔复验记录。
原打孔服务的数据文件与接口全部保留，在此之上增加补孔复验工作流。

## 启动

```bash
PORT=3019 node server.js
```

## 复验规则

- 每次复验登记：试奏回合（`round` 自动递增）、试奏拍号 `beat`、残留孔位 `residualHoles`（无残留传 `[]`）、是否补孔 `patched`、现场结论 `conclusion`。
- 同一问题连续两次复验，残留点位数量相比上一回合没有缩小（持平或增多），自动**冻结整条曲带**。
- 冻结期间除登记复验外，曲目/区间/问题的变更接口一律 409 拒绝。
- 只有在触发冻结的问题上：`patched=true` 且在**更后拍号**复奏且 `residualHoles=[]`，才自动**解冻**。
- 批量登记任一记录缺少残留孔位或现场结论（或引用不存在的问题等），整批拒绝、不落盘，原状态、进度与问题记录不变。
- 历史问题没有复验记录时，`reviewState` 为 `unreinspected`。

## 接口

原有接口（响应兼容，曲目/进度/问题上新增冻结与复验字段）：

- `GET /health`
- `GET /tunes` / `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections` / `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

复验台接口：

- `GET /issues/:id/reinspections` — 该问题的复验回合与复验概况
- `POST /issues/:id/reinspections` — 登记一次复验
- `GET /reinspections?tuneId=&issueId=` — 复验记录查询
- `POST /reinspections/batch` — 批量登记（原子校验）

### 登记复验示例

```bash
curl -X POST http://127.0.0.1:3019/issues/issue_demo/reinspections \
  -H 'Content-Type: application/json' \
  -d '{"beat":44,"patched":true,"residualHoles":[{"beat":44,"lane":12}],"conclusion":"补孔后仍有残留"}'

curl -X POST http://127.0.0.1:3019/reinspections/batch \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"issueId":"issue_demo","beat":48,"patched":true,"residualHoles":[],"conclusion":"复奏无残留"}]}'
```

响应中 `action` 为 `recorded` / `frozen` / `unfrozen`，`tune` 返回曲带最新冻结状态。
