# dsh-model-sync

DeepSeek Harness (DSH) 插件：为自定义与第三方中转提供商自动发现最新线上模型、以 [models.dev](https://models.dev) 为标准对齐能力规格，并在 Web 管理界面的模型设置页中注入优雅的一键刷新按钮。

---

## 核心特性

- **Web 界面一键刷新按钮**：自动挂载在 DSH 模型设置卡片与能力面板头部，带有悬停 360° 旋转与加载反馈动画，完成后弹出 Toast 通知同步统计。
- **防止中转计费阈值截断**：采用 `Math.max(网关值, 官方标准值)`，避免网关内部 272k、128k 等计费阶梯压低模型真实上下文（例如将 `gpt-6-astra` 恢复至官方 1,050,000 上下文）。
- **智能标签与路由后缀剥离**：自动识别并剥离中转特有的计费标签（如 `[1m]`）、路由标记（`-review`、`-sol`、`-luna`）以及版本变体（`-high`、`-low`、`-tiered`），精确命中官方能力数据库。
- **只写 DSH 认的字段（v1.1.0）**：仅输出 DSH 模型条目接受的 `id`、`name`、`contextWindow`、`maxTokens`、`input`（仅 `text`/`image`）、`reasoningEfforts`。非推理模型写 `reasoningEfforts: false`；推理模型只写 models.dev 给出的真实 DSH 档位（`off`~`max`），不会写出只有 `off` 的字典，也不会凭空编档位。
- **写入安全（v1.1.0）**：写入前按 DSH 自身规则逐行校验；无效行与非聊天 id（embedding/TTS/图像/审核）会被跳过并上报。无变化时不写入；网关拉取失败会报错而不是用旧数据重写目录；各提供商独立写入。
- **旧数据修复**：1.0.x 写入的 `reasoning`、`thinkingLevelMap`、`thinkingFormat`、`compat.thinkingFormat: "effort"`（DSH 会拒绝）在下次同步时自动清理；用户设置的 wire 值与自定义字段保留。
- **凭据**：按 DSH 的方式解析网关密钥（`apiKeyEnv` 经 credentials 服务，其次同名环境变量）。
- **Cordis 原生架构**：基于 Cordis 依赖注入与生命周期模型，通过 bundle patch 自动装配，支持热插拔与定时静默同步。

---

## 安装与配置

在 DSH 运行环境中，使用官方 CLI 直接安装：

```bash
# 从 npm 安装
dsh plugin --profile web add dsh-model-sync

# 或从 GitHub 安装
dsh plugin --profile web add github:kim1232aa/dsh-model-sync
```

安装后重启 DSH，或重新加载 Web 界面。

---

## 界面交互与效果

1. 打开 DSH Web 界面：**设置 → 模型 (Models)**。
2. 在提供商配置面板或能力设置头部，即可看到新增的刷新图标。
3. 鼠标悬停时图标平滑旋转，点击即可触发实时同步。
4. 同步完成后，右下角 Toast 会按提供商显示新增 / 更新 / 移除数量、“已是最新”、被跳过的模型及各提供商的错误。

预览（不写入）：从本机回环向 `POST /api/dsh-model-sync/refresh` 发送 `{"dryRun": true}`，返回同样的结果列表且 `wrote: false`。

---

## 卸载

```bash
dsh plugin --profile web remove dsh-model-sync
```

---

## 协议

MIT License
