import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Check, CircleCheck, CircleDashed, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DEFAULT_BUILD_OPTIONS,
  DEFAULT_TEMPLATE,
  MOD_CATEGORIES,
  MOD_TEMPLATES,
  SAFE_DESC_LENGTH,
  checkConflicts,
  editableReadme,
  parseIdList,
  parseLines,
  parseTags,
  slugifyModId,
  templateOf,
  validateNewMod,
  type ModBuildOptions,
  type NewModInput,
} from "@/lib/mod-logic"
import { isServerRootValid, type ModEntry } from "@/lib/mock"
import { cn } from "@/lib/utils"

/** 构建选项：三项都是开关，排成一行，跟骨架文件一起生成 */
const BUILD_OPTIONS: { key: keyof ModBuildOptions; label: string }[] = [
  { key: "restart", label: "需要重启服务端" },
  { key: "enableAfterCreate", label: "建好后立即启用" },
  { key: "signAfterCreate", label: "建好后立即签名" },
]

/**
 * 「将生成」里那份文件树。目录名用当前填的标识，还没填就留 <id> 占位；
 * 启用选项会影响 loader 的文件名。
 */
function generatedTree(id: string, enableAfterCreate: boolean): string {
  return [
    `mods/${id.trim() || "<id>"}/`,
    "├─ evejs-launcher.mod.json",
    `├─ loader.js${enableAfterCreate ? "" : ".disabled"}`,
    "├─ README.md",
    "└─ CHANGELOG.md",
  ].join("\n")
}

/**
 * 生成骨架的六步，跟「将生成」那份文件树一一对应，最后一步落到本地模组库。
 * 这几步本身是瞬间完成的，走一遍是为了让作者看见往磁盘上写了什么。
 */
function buildSteps(dir: string, enableAfterCreate: boolean): string[] {
  return [
    `创建目录 mods/${dir.trim() || "<id>"}/`,
    "写入 evejs-launcher.mod.json",
    `写入 loader.js${enableAfterCreate ? "" : ".disabled"}`,
    "写入 README.md",
    "写入 CHANGELOG.md",
    "注册到本地模组库",
  ]
}

/** 每一步停留多久，六步加起来一秒半左右 */
const BUILD_STEP_MS = 240

/**
 * 创建与编辑共用一份表单：字段基本一样，差别在 ID 与版本能不能改。
 * 创建是「生成一份骨架」，所以模板、构建选项、将生成这几块只在创建时出现；
 * 编辑只改信息，不重新生成文件。
 * 编辑时不传 existingIds 校验重名——ID 本身是锁死的，不可能撞上别人。
 */
export function ModFormDialog({
  open,
  onOpenChange,
  mod = null,
  existingIds,
  onSubmit,
  serverRoot,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传模组就是改信息，不传就是新建 */
  mod?: ModEntry | null
  /** 已有的模组 ID，用来挡住重名 */
  existingIds: string[]
  onSubmit: (input: NewModInput) => void
  /** 服务端根目录：模组目录相对它定位，指错了骨架就落错地方 */
  serverRoot: string
}) {
  const editing = mod !== null

  const [template, setTemplate] = useState<string>(DEFAULT_TEMPLATE)
  const [name, setName] = useState("")
  const [id, setId] = useState("")
  const [version, setVersion] = useState("1.0.0")
  const [cat, setCat] = useState<string>(MOD_CATEGORIES[0])
  const [tags, setTags] = useState("")
  const [desc, setDesc] = useState("")
  const [readme, setReadme] = useState("")
  const [features, setFeatures] = useState("")
  const [conflicts, setConflicts] = useState("")
  const [build, setBuild] = useState<ModBuildOptions>(DEFAULT_BUILD_OPTIONS)
  /** 作者自己动过标识之后就不再跟着模组名走，免得覆盖他挑好的 id */
  const [idTouched, setIdTouched] = useState(false)
  /** 按字数算，中文一个字算一个，跟卡片上占的宽度对得上 */
  const descCount = [...desc].length
  /** 建骨架的进度：正在生成、已走完几步、这一次要走哪几步 */
  const [building, setBuilding] = useState(false)
  const [buildStep, setBuildStep] = useState(0)
  const [buildLabels, setBuildLabels] = useState<string[]>([])
  /** 生成完才真正落库，待提交的内容先挂在这里 */
  const pending = useRef<NewModInput | null>(null)
  /** 回调挂 ref：父级每次重渲染都会换函数身份，进依赖会把计时器打断 */
  const latest = useRef({ onSubmit, onOpenChange })
  latest.current = { onSubmit, onOpenChange }

  // 每次打开都按当前对象铺一遍，改到一半关掉再打开不会留着上一次的残留
  useEffect(() => {
    if (!open) return
    setTemplate(DEFAULT_TEMPLATE)
    setName(mod?.name ?? "")
    setId(mod?.id ?? "")
    setIdTouched(false)
    setVersion(mod?.version ?? "1.0.0")
    setCat(mod?.cat ?? MOD_CATEGORIES[0])
    setTags((mod?.tags ?? []).join(", "))
    setDesc(mod?.desc ?? "")
    const body = mod ? editableReadme(mod) : { intro: "", features: [] }
    setReadme(body.intro)
    setFeatures(body.features.join("\n"))
    setConflicts((mod?.conflicts ?? []).join(", "))
    setBuild(DEFAULT_BUILD_OPTIONS)
    setBuilding(false)
    setBuildStep(0)
    setBuildLabels([])
    pending.current = null
  }, [open, mod])

  // 逐行走完生成步骤，走完才把模组交出去并关窗
  useEffect(() => {
    if (!building) return
    if (buildStep >= buildLabels.length) {
      const payload = pending.current
      pending.current = null
      setBuilding(false)
      setBuildStep(0)
      if (payload) {
        latest.current.onSubmit(payload)
        latest.current.onOpenChange(false)
      }
      return
    }
    const timer = window.setTimeout(
      () => setBuildStep((prev) => prev + 1),
      BUILD_STEP_MS
    )
    return () => window.clearTimeout(timer)
  }, [building, buildStep, buildLabels.length])

  function submit() {
    const trimmedName = name.trim()
    const trimmedId = id.trim()
    const error = validateNewMod(
      { name: trimmedName, id: trimmedId },
      editing ? [] : existingIds
    )
    if (error) {
      toast.error(
        error.message,
        error.detail ? { description: error.detail } : undefined
      )
      return
    }

    const payload: NewModInput = {
      name: trimmedName,
      id: trimmedId,
      version: editing ? version : version.trim() || "1.0.0",
      cat,
      desc: desc.trim(),
      tags: parseTags(tags),
      template,
      readme,
      features: parseLines(features),
      conflicts: parseIdList(conflicts),
      build,
    }

    // 编辑只改信息，不重新生成文件，所以只有新建才走生成进度
    if (editing) {
      onSubmit(payload)
      onOpenChange(false)
      return
    }
    pending.current = payload
    setBuildLabels(buildSteps(trimmedId, build.enableAfterCreate))
    setBuildStep(0)
    setBuilding(true)
  }

  const picked = templateOf(template)
  const conflictCheck = checkConflicts(
    parseIdList(conflicts),
    id.trim(),
    existingIds
  )
  // 名字里没有能当标识的字符（中文名就是），又还没填 id —— 提示作者自己起一个
  const needsManualId =
    !editing &&
    id.trim() === "" &&
    name.trim() !== "" &&
    slugifyModId(name) === ""

  const buildPct = buildLabels.length
    ? (buildStep / buildLabels.length) * 100
    : 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 生成到一半关掉会留下写了一半的骨架，这期间不让关
        if (building && !next) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-2">
            <span className="tabular text-[10px] font-semibold tracking-[0.18em] text-primary/85">
              {editing ? "// EDIT MOD" : "// CREATE MOD"}
            </span>
            <span>{editing ? `编辑「${mod.name}」` : "创建模组"}</span>
          </DialogTitle>
          {editing ? (
            <DialogDescription>
              改完立即生效。ID 与版本不在这里改，已上架的模组改完，市场里的说明会同步更新。
            </DialogDescription>
          ) : (
            /* 先讲清楚这一下会往磁盘上写什么，免得以为只是登记一条信息 */
            <DialogDescription className="rounded-md border border-border bg-background/40 px-3 py-2 text-[11px] leading-relaxed text-tertiary">
              骨架以已跑通的 <code className="tabular text-primary/85">welcome-mod</code>{" "}
              为基准生成：<code className="tabular text-primary/85">evejs-launcher.mod.json</code>{" "}
              + <code className="tabular text-primary/85">loader.js</code> +{" "}
              <code className="tabular text-primary/85">README.md</code> +{" "}
              <code className="tabular text-primary/85">CHANGELOG.md</code>
              ，新模组默认禁用，不会自动加载。
            </DialogDescription>
          )}
        </DialogHeader>

        {building ? (
          /* 生成进度：跟「将生成」那份文件树一一对应，走到哪一步一眼看得见 */
          <div className="space-y-3 py-1">
            <div className="flex flex-wrap items-center gap-2">
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
              <span className="text-[13px] font-semibold text-foreground">
                正在生成「{name.trim()}」的骨架
              </span>
              <div className="min-w-2 flex-1" />
              <span className="tabular text-[12px] font-bold text-primary">
                {Math.floor(buildPct)}%
              </span>
            </div>

            <Progress value={buildPct} />

            <ul className="space-y-1.5">
              {buildLabels.map((label, index) => {
                const phase =
                  index < buildStep
                    ? "done"
                    : index === buildStep
                      ? "running"
                      : "queued"
                return (
                  <li
                    key={label}
                    className={cn(
                      "flex items-center gap-2 text-[12px]",
                      phase === "queued" && "opacity-55"
                    )}
                  >
                    {phase === "done" ? (
                      <CircleCheck className="size-3.5 shrink-0 text-success" />
                    ) : phase === "running" ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                    ) : (
                      <CircleDashed className="size-3.5 shrink-0 text-tertiary" />
                    )}
                    <span
                      className={cn(
                        "tabular truncate",
                        phase === "running"
                          ? "text-primary"
                          : phase === "done"
                            ? "text-muted-foreground"
                            : "text-tertiary"
                      )}
                    >
                      {label}
                    </span>
                  </li>
                )
              })}
            </ul>

            <p className="text-[11px] leading-relaxed text-tertiary">
              按「{picked.name}」模板生成 · {picked.size}
              ，生成完停在草稿里，不会自动上架。
            </p>
          </div>
        ) : (
        /* 字段较多，限高滚动，免得在矮窗口里把页脚挤出屏幕 */
        <ScrollArea className="-mr-2 max-h-[60vh] pr-2">
          <div className="space-y-3">
            {editing ? null : (
              <div className="space-y-1.5">
                <Label>从模板开始</Label>
                {/* 两张卡片并排：名字 + 体积一行，说明一行，选中的描青边打勾 */}
                <div className="grid gap-2 sm:grid-cols-2">
                  {MOD_TEMPLATES.map((item) => {
                    const active = item.id === template
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setTemplate(item.id)}
                        className={cn(
                          "rounded-md border px-3 py-2 text-left transition-colors",
                          active
                            ? "border-primary/60 bg-primary/10"
                            : "border-input bg-background/40 hover:border-border hover:bg-secondary/50"
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "text-[13px] font-semibold",
                              active ? "text-primary" : "text-foreground"
                            )}
                          >
                            {item.name}
                          </span>
                          {active ? <Check className="size-3.5 text-primary" /> : null}
                          <span className="min-w-2 flex-1" />
                          <span className="tabular shrink-0 text-[10px] text-tertiary">
                            {item.size}
                          </span>
                        </span>
                        <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                          {item.desc}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* 名字和标识是一对：一个给人看，一个给目录用，并排放省一屏 */}
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mod-form-name">模组名</Label>
                <Input
                  id="mod-form-name"
                  value={name}
                  onChange={(event) => {
                    const next = event.target.value
                    setName(next)
                    // 标识跟着名字走，直到作者自己动过标识为止
                    if (!editing && !idTouched) setId(slugifyModId(next))
                  }}
                  placeholder="我的第一个模组"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="mod-form-id">标识（id / 目录名）</Label>
                <Input
                  id="mod-form-id"
                  value={id}
                  onChange={(event) => {
                    const next = event.target.value
                    setId(next)
                    // 手动清空等于把标识交回自动推导，接着打名字会重新跟
                    setIdTouched(next.trim() !== "")
                  }}
                  placeholder="my-first-mod"
                  disabled={editing}
                  className="tabular"
                />
                <p className="text-[11px] text-tertiary">
                  {editing
                    ? "创建后不可修改。"
                    : idTouched
                      ? "手动改过，不再跟着模组名走；清空可以交回自动推导。"
                      : "跟着模组名自动生成；仅小写字母、数字与短横，创建后不可修改。"}
                </p>
                {needsManualId ? (
                  <p className="text-[11px] leading-relaxed text-warning">
                    这个名字推不出可用的标识，自己起一个英文或拼音的 id。
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid items-start gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mod-form-version">版本</Label>
                <Input
                  id="mod-form-version"
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                  placeholder="1.0.0"
                  disabled={editing}
                  className="tabular"
                />
                <p className="text-[11px] text-tertiary">
                  {editing ? "改版本请用详情里的「发布新版本」。" : "首次上架用的版本号。"}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>分类</Label>
                <Select value={cat} onValueChange={setCat}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择分类" />
                  </SelectTrigger>
                  <SelectContent>
                    {MOD_CATEGORIES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mod-form-tags">标签（逗号分隔）</Label>
              <Input
                id="mod-form-tags"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="聊天, 新手"
              />
              <p className="text-[11px] text-tertiary">最多 5 个。</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mod-form-desc">简介</Label>
              <Input
                id="mod-form-desc"
                value={desc}
                onChange={(event) => setDesc(event.target.value)}
                placeholder="一句话说明这个模组做什么"
              />
              {/* 卡片上只有三行，写超了会被省略号截掉；这里只提示不拦，详情页仍旧显示全文 */}
              <p
                className={cn(
                  "tabular text-[11px]",
                  descCount > SAFE_DESC_LENGTH ? "text-warning" : "text-tertiary"
                )}
              >
                已写 {descCount} 字 · 卡片上最多三行（约 {SAFE_DESC_LENGTH} 字），再长卡片上会省略，详情里能看全。
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mod-form-readme">详细介绍（写进 README）</Label>
              <Textarea
                id="mod-form-readme"
                rows={4}
                value={readme}
                onChange={(event) => setReadme(event.target.value)}
                placeholder="可以分段，支持 Markdown"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mod-form-features">功能要点（每行一条，写进 README）</Label>
              <Textarea
                id="mod-form-features"
                rows={3}
                value={features}
                onChange={(event) => setFeatures(event.target.value)}
                placeholder="玩家上线后收到一条系统消息"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mod-form-conflicts">
                冲突模组 id（逗号分隔，可留空）
              </Label>
              <Input
                id="mod-form-conflicts"
                value={conflicts}
                onChange={(event) => setConflicts(event.target.value)}
                placeholder="other-mod"
                className="tabular"
              />
              {conflictCheck.self ? (
                <p className="text-[11px] text-warning">
                  冲突列表里写了自己，这条声明没有意义，去掉即可。
                </p>
              ) : null}
              {conflictCheck.unknown.length > 0 ? (
                <p className="text-[11px] leading-relaxed text-warning">
                  模组库里没有{" "}
                  <span className="tabular">{conflictCheck.unknown.join("、")}</span>
                  ，确认 id 没写错；对方还没发布的话可以照实留着。
                </p>
              ) : null}
            </div>

            {editing ? null : (
              <div className="space-y-1.5">
                <Label>构建选项</Label>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-input bg-background/40 px-3 py-2.5">
                  {BUILD_OPTIONS.map((option) => (
                    <label
                      key={option.key}
                      className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground"
                    >
                      <Checkbox
                        checked={build[option.key]}
                        onCheckedChange={(next) =>
                          setBuild((prev) => ({
                            ...prev,
                            [option.key]: next === true,
                          }))
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {editing ? null : (
              <div className="space-y-1.5">
                <Label>将生成</Label>
                <div className="rounded-md border border-input bg-background/60 px-3 py-2.5">
                  <pre className="tabular whitespace-pre text-[11px] leading-relaxed text-muted-foreground">
                    {generatedTree(id, build.enableAfterCreate)}
                  </pre>
                </div>
                <p className="text-[11px] leading-relaxed text-tertiary">
                  按「{picked.name}」模板生成 · {picked.size}
                </p>
                {isServerRootValid(serverRoot) ? null : (
                  <p className="text-[11px] leading-relaxed text-destructive">
                    服务端根目录现在指向{" "}
                    <span className="tabular break-all">
                      {serverRoot || "（空）"}
                    </span>
                    ，这份骨架建到那里服务端加载不到。
                  </p>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={building}
          >
            取消
          </Button>
          <Button onClick={submit} disabled={building}>
            {building ? "生成中…" : editing ? "保存修改" : "创建模组"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
