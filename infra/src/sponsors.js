/**
 * 补给线（赞助人）名单 —— 服务端侧的**唯一事实来源**。
 *
 * 改名单只动这个文件，然后重新部署 Worker（`npx wrangler deploy`，或让 CI 跑），
 * 启动器那边**不用发版**：它读的是定时任务算出来并签名的快照
 * （多镜像 + 本地缓存 + 验签，与模组市场的评分同一套读法）。
 *
 * 字段：
 *   id        稳定标识，给启动器的动画层做 key 与去重；留空按顺序生成 `sponsor-01`
 *   name      显示名（**用户数据**，启动器一律不翻译）
 *   amount    金额，非负数，最多两位小数
 *   currency  三位字母币种码：CNY / USD / EUR / GBP / JPY / KRW / RUB ...
 *             启动器按它挑符号（¥ $ € £ ₩ ₽），认不出来的码原样显示成「XYZ 20」
 *
 * ⚠️ 下面这份是**占位数据**，接真实名单时整份换掉：
 *   - 中文那批取自原型截图，后 4 条是凑数的；
 *   - `Cmdr. Nova` / `Star Drifter` 两条是**美元示例**，专门用来验证「不全是人民币」这条路径。
 */
export const SPONSOR_LIST = [
  { id: "sponsor-01", name: "星海孤舟", amount: 666, currency: "CNY" },
  { id: "sponsor-02", name: "星轨拾荒者", amount: 500, currency: "CNY" },
  { id: "sponsor-03", name: "深空引导员", amount: 300, currency: "CNY" },
  { id: "sponsor-04", name: "托肯太鸽", amount: 288, currency: "CNY" },
  { id: "sponsor-05", name: "星门守望者", amount: 128, currency: "CNY" },
  { id: "sponsor-06", name: "冰原守望", amount: 100, currency: "CNY" },
  { id: "sponsor-07", name: "星尘补给", amount: 32.66, currency: "CNY" },
  { id: "sponsor-08", name: "深邃的旅人", amount: 13.14, currency: "CNY" },
  { id: "sponsor-09", name: "沉眠的探险", amount: 13.14, currency: "CNY" },
  { id: "sponsor-10", name: "何叔的看板娘", amount: 9.9, currency: "CNY" },
  { id: "sponsor-11", name: "青衫如故", amount: 7.6, currency: "CNY" },
  { id: "sponsor-12", name: "星穹勘探工", amount: 7.6, currency: "CNY" },
  { id: "sponsor-13", name: "匿名的指挥官", amount: 6.6, currency: "CNY" },
  { id: "sponsor-14", name: "星海领航员", amount: 1.1, currency: "CNY" },
  { id: "sponsor-15", name: "Cmdr. Nova", amount: 50, currency: "USD" },
  { id: "sponsor-16", name: "Star Drifter", amount: 12.5, currency: "USD" },
]
