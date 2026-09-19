# EvEJS Launcher 开发与发布约定

## 版本节奏

- 每累计 8 个独立、用户可感知的改动组成一个版本。
- 纯重构、格式化、测试脚本调整和内部依赖清理默认不计入；如果影响用户行为，则计入。
- 计数记录在 `release-notes/pending.json`。
- 达到 8 项后，停止继续堆叠新功能，先准备版本发布。

## 达到 8 项后的流程

1. 将 `package.json`、`package-lock.json` 和界面版本号提升到下一个 `PATCH` 版本。
2. 创建 `release-notes/vX.Y.Z.json`，同时提供 `changelog.zh` 和 `changelog.en`。
3. 运行 `npm run build`，必要时运行 smoke 测试。
4. 提醒用户提交到 Git，不自动提交、不自动打标签。
5. 用户确认后，提交信息必须同时包含中文和英文摘要，再推送 `main` 和 `vX.Y.Z` 标签。

达到 8 项时，提示用户使用类似命令：

```powershell
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "EvEJS Launcher vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

## 更新日志格式

正式版本使用以下文件：

```text
release-notes/vX.Y.Z.json
```

内容必须同时包含中文和英文：

```json
{
  "version": "0.1.11",
  "changelog": {
    "zh": [
      { "type": "new", "text": "中文更新说明" },
      { "type": "fix", "text": "中文修复说明" }
    ],
    "en": [
      { "type": "new", "text": "English release note" },
      { "type": "fix", "text": "English fix note" }
    ]
  }
}
```

- `type` 只能是 `new`、`fix`、`opt`。
- 中文用户读取 `changelog.zh`，其他语言用户读取 `changelog.en`。
- Git 提交记录只能作为缺少正式版本说明时的兜底，不能替代 `release-notes`。

## 待发布变更记录

每次完成一个用户可见改动后，更新 `release-notes/pending.json`，记录中英文摘要和类型。达到 8 项后按上面的流程发布。
