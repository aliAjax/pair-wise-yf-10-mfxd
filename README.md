# 手摇风琴纸带补孔复验台

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题与补孔复验记录。
原打孔校对接口全部保留，新增复验登记、残留孔位追踪与曲带冻结/解除能力。

## 启动

```bash
PORT=3019 node server.js
```

## 接口

原接口（响应向后兼容，仅附加字段）：

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

复验台新增：

- `GET /issues/:id/reinspections` — 某问题的全部复验回合（含问题复验状态与曲带冻结态）
- `POST /issues/:id/reinspections` — 登记单回合复验
- `POST /reinspections/batch` — 批量登记复验，body：`{ "entries": [ ... ] }`

## 复验登记字段

每次复验登记：

| 字段 | 说明 |
| --- | --- |
| `replayBeat` | 本回合复奏拍号（数字，必填） |
| `patched` | 本回合是否已补孔，默认 `false` |
| `residualHoles` | 残留孔位数组，每项 `{ "beat": 41, "lane": 12 }`；**无残留必须传空数组 `[]`，缺字段即拒绝** |
| `conclusion` | 现场结论（非空字符串，必填） |
| `note` | 备注，可选 |

试奏回合 `round` 按问题自动从 1 递增。

## 冻结规则

- 同一问题相邻两轮复验：新一轮残留点位集合必须是上一轮的**严格子集**（点位减少且没有新增点位）才算“残留缩小”。
- 连续两次未缩小（即两轮后 `noShrinkStreak >= 2`）→ **冻结整条曲带**：该曲带除复验登记外的所有写操作（新区间、勾选、问题增改、问题状态）返回 `409`。
- 解除条件（必须同时满足）：对触发冻结的问题
  1. 已补孔（`patched: true`）；
  2. 在**更后拍号**复奏（`replayBeat` 严格大于冻结时拍号）；
  3. 当回合无残留（`residualHoles: []`）。
  系统自动解除冻结，复验响应 `action` 为 `"unfrozen"`；触发冻结时为 `"frozen"`。

## 批量录入

`POST /reinspections/batch` 对每个条目先做整批校验：任一问题不存在、缺少残留孔位（含未传 `residualHoles`）或现场结论为空/缺失，整批返回 `400` 并列出 `rejected` 明细，**不写入任何数据**，原状态、进度与问题记录不变。全部通过后才统一落盘。

## 历史数据

无复验记录的问题按“未复验”处理：`GET /issues` 与单问题响应中的 `verification.state = "unreinspected"`。旧数据文件读取时自动补齐 `reinspections` 与曲带 `freeze` 字段。

## 示例

```bash
# 单回合复验：第41拍补孔后复奏，还剩一个残留孔
curl -X POST http://127.0.0.1:3019/issues/issue_demo/reinspections \
  -H 'Content-Type: application/json' \
  -d '{"replayBeat":41,"patched":true,"residualHoles":[{"beat":42,"lane":9}],"conclusion":"补孔后高音轨仍有杂音"}'

# 更后拍号再次复奏，无残留（若此前被冻结，本回合自动解除）
curl -X POST http://127.0.0.1:3019/issues/issue_demo/reinspections \
  -H 'Content-Type: application/json' \
  -d '{"replayBeat":52,"patched":true,"residualHoles":[],"conclusion":"复奏顺畅，无残留"}'

# 批量（任一条缺 residualHoles 或 conclusion 即整批拒绝）
curl -X POST http://127.0.0.1:3019/reinspections/batch \
  -H 'Content-Type: application/json' \
  -d '{"entries":[{"issueId":"issue_demo","replayBeat":60,"patched":true,"residualHoles":[],"conclusion":"通过"}]}'
```
