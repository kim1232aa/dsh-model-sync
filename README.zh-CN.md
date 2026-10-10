# dsh-model-sync

DeepSeek Harness (DSH) 插件：为自定义与第三方中转提供商自动发现最新线上模型、以 [models.dev](https://models.dev) 为标准对齐能力规格，并在 Web 管理界面的模型设置页中注入优雅的一键刷新按钮。

---

## 核心特性

- **Web 界面一键刷新按钮**：自动挂载在 DSH 模型设置卡片与能力面板头部，带有悬停 360° 旋转与加载反馈动画，完成后弹出 Toast 通知同步统计。
- **防止中转计费阈值截断**：采用 `Math.max(网关值, 官方标准值)`，避免网关内部 272k、128k 等计费阶梯压低模型真实上下文（例如将 `gpt-6-astra` 恢复至官方 1,050,000 上下文）。
- **智能标签与路由后缀剥离**：自动识别并剥离中转特有的计费标签（如 `[1m]`）、路由标记（`-review`、`-sol`、`-luna`）以及版本变体（`-high`、`-low`、`-tiered`），精确命中官方能力数据库。
- **UI 状态强一致性保证**：若模型配置了有效思考档位，强制锁定 `reasoning: true`；若判定为非推理模型，彻底清理思考映射，杜绝前端出现“未勾选推理却显示思考等级”的矛盾。
- **Cordis 原生架构**：基于 Cordis 依赖注入与生命周期模型，通过 bundle patch 自动装配，支持热插拔与定时静默同步。

---

## 安装与配置

在 DSH 运行环境中，使用官方 CLI 直接安装：

```bash
# 从 npm 安装
dsh plugin --profile web add dsh-model-sync

# 或从 GitHub 安装
dsh plugin --profile web add github:your-username/dsh-model-sync
```

安装后重启 DSH，或重新加载 Web 界面。

---

## 界面交互与效果

1. 打开 DSH Web 界面：**设置 → 模型 (Models)**。
2. 在提供商配置面板或能力设置头部，即可看到新增的刷新图标。
3. 鼠标悬停时图标平滑旋转，点击即可触发实时同步。
4. 同步完成后，右下角将弹出 Toast 卡片，提示各提供商的新增与更新数量。

---

## 卸载

```bash
dsh plugin --profile web remove dsh-model-sync
```

---

## 协议

MIT License
