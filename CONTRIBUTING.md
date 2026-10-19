# 参与贡献

感谢你愿意改进 minicode。这个项目优先接受小而清晰、能够复现和验证的改动。

## 开发环境

- Node.js 22.18 或更高版本
- npm（随 Node.js 安装）
- Git

安装开发依赖并启动：

```bash
npm ci
npm run chat  # CLI
npm run web   # Web，默认 http://localhost:3000
```

应用本身零运行时依赖；`npm ci` 安装的是 lint、类型检查和测试所需的开发依赖。

## 提交改动

1. 基于 `main` 创建短分支，例如 `web-timeline` 或 `fix-ci`。
2. 保持改动聚焦，避免在同一提交中混入无关重构。
3. 使用 Conventional Commits 风格的提交信息，例如：

   ```text
   fix(web): keep failed tool calls visible
   feat(tools): add a new travel data source
   docs: clarify local configuration
   ```

4. 发起 Pull Request，并说明用户可见行为、实现取舍和验证方式。

## 提交前检查

请在仓库根目录运行：

```bash
npm run lint
npm run typecheck
npm test
```

GitHub Actions 会在 Node.js 22.18 和 24 上重复执行这些检查。不要在 CI 中依赖本地的真实行程、模型 Key 或网络数据。

如果改动涉及行程质量规则、提示词、评测指标或工具轮次预算，建议额外在保留本地 `plans/` 数据的机器上执行：

```bash
npm run eval:plans -- --diff
```

真实模型评测使用 `npm run eval:live`，会产生 API 费用，且结果受模型和外部数据源波动影响，因此不属于 CI 的必跑项。

## 数据与密钥

- 不要提交 API Key、`.minicode/`、会话记录、导入的旅行者档案或运行时生成的 `plans/` 文件。
- 不要提交 `eval/out/` 下的临时评测报告。
- 测试中应使用固定样例或 Mock 数据，不要依赖个人账户和不可复现的外部响应。
- 提交前检查 `git diff`，确认没有把 `.minicode/config.json`、`.minicode/models.json` 等本地配置带入版本库。

## 许可证

向本仓库提交贡献即表示你同意该贡献以仓库的 [MIT License](LICENSE) 授权。
