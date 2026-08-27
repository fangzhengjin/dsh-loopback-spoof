# dsh-loopback-spoof

> **安全警告**
>
> - 此 Bundle 会有意绕过 DSH Web 的本地来源保护。
> - 默认监听地址为 `0.0.0.0:3080`。
> - 不提供认证、TLS、速率限制或访问审计。
> - 禁止直接暴露到公网或不可信网络。
> - 仅限已配置防火墙、专用网络或上游认证的环境使用。

## 一眼了解

| 项目 | 说明 |
| --- | --- |
| 安装效果 | 同时切换 Host 与浏览器侧的 loopback 判断 |
| Host 请求 | 动态 HTTP 和 WebSocket handler 看到本机来源 |
| 浏览器连接 | `ctx.connection.isLoopback` 固定为 `true` |
| 官方复用 | 继续使用 DSH 官方 WebServer 与 Connection 实现 |
| 持久化数据 | 不迁移 Session、设置或凭据 |
| 卸载结果 | 重启 Profile 后恢复官方 WebServer 与 Connection |

## 快速导航

1. [使用前必须确认](#使用前必须确认)
2. [安装](#安装)
3. [验证安装](#验证安装)
4. [卸载与回退](#卸载与回退)
5. [行为说明](#行为说明)
6. [开发与发布检查](#开发与发布检查)

## 使用前必须确认

- [ ] 防火墙、专用网络或上游认证已经限制 3080 端口。
- [ ] 当前 Web Profile 已停止。
- [ ] 当前 Web Profile 未同时启用其他替代 WebServer 或 Connection provider。
- [ ] 已保留下方的回退命令。
- [ ] 已明确选择监听范围：
  - 默认：`0.0.0.0:3080`
  - 仅本机：启动时传入 `--host 127.0.0.1`

## 风险边界

### 能够访问端口的调用方可能执行

1. 调用配置、凭据、Agent、工具和插件接口。
2. 调用第三方动态路由。
3. 使用原本只向本机浏览器呈现的能力：
   - 写入设置；
   - 打开配置文件；
   - 打开 Host 路径。
4. 让 DSH Host 携带调用方提供的草稿凭据请求指定地址。

### 不会改变

- 静态文件与 SPA fallback 不会被改写。
- 文件和文件夹打开仍发生在 DSH Host 所在机器。
- 模型发现与工具执行仍发生在 DSH Host 所在机器。
- `hasDocument`、`canOpenPath` 等 Host 能力判断仍然保留。

## 安装

> **安装来源**
>
> - 当前只支持从 GitHub 安装。
> - 仓库：<https://github.com/fangzhengjin/dsh-loopback-spoof>
> - 本项目已设置 `private: true`，防止误发布到 npm registry。

### 1. 从 GitHub 安装

```bash
plugin_spec='github:fangzhengjin/dsh-loopback-spoof#main'
dsh plugin --profile web add "$plugin_spec"
```

- 当前开发安装使用 `#main`。
- 需要可复现部署时，将 `main` 替换为已经审查的 commit SHA。

仓库已提交编译后的 `lib/`，GitHub 安装直接使用这些产物：

- 安装时不运行构建脚本。
- 不需要在 Profile 中配置 `allowBuilds`。
- 每次提交前必须运行完整检查，确认 `lib/` 与源码一致。

### 2. 检查配置并启动

```bash
dsh --profile web --dump-config
dsh --profile web --no-open
```

`--dump-config` 应满足：

- 只出现一个 `dsh-loopback-spoof/webserver`。
- 只出现一个根 `dsh-loopback-spoof`。
- 官方 `webserver` 和 `@deepseek-ai/dsh-client-connection` 行均为 disabled。

## 验证安装

```bash
ss -ltnp | grep ':3080'

curl --include \
  --header 'Host: dsh.example:3080' \
  --header 'Origin: http://dsh.example:3080' \
  --header 'Sec-Fetch-Site: cross-site' \
  'http://127.0.0.1:3080/api/events.mux'
```

预期结果：

1. **监听范围**
   - 默认：`0.0.0.0:3080`
   - 传入 `--host 127.0.0.1`：仅本机监听
2. **API 路由**
   - 普通 GET 到达 WebSocket 路由
   - 返回 426，而不是来源检查阶段的 403
3. **浏览器**
   - 受信任 LAN 浏览器可以打开页面
   - 所需的本地能力可见

> **验证失败时**
>
> 任一结果不符合预期时，立即停止 Profile，并按下一节回退。

## 卸载与回退

```bash
dsh plugin --profile web remove dsh-loopback-spoof
dsh --profile web --dump-config
dsh --profile web --no-open
```

恢复结果：

1. dump 不再包含两个组合入口。
2. 官方 WebServer 与 Connection 在下一次启动时恢复。
3. 无需迁移或回滚业务数据。

## 行为说明

| 范围 | 安装后的行为 | 保持不变的部分 |
| --- | --- | --- |
| 动态 HTTP 与 WebSocket | handler 看到 loopback 请求头和 socket 来源 | 官方路由 dispatcher 与生命周期 |
| Host Connection | 继续提供官方 `/api` HTTP 和 WebSocket | 官方 Connection 实现 |
| 浏览器 Connection | `ctx.connection.isLoopback` 固定为 `true` | 官方 provider、RPC 和传输实现 |
| 静态文件与 SPA | 不改写请求 | 官方 `registerFallback()` 与 index 注入 |
| 持久化数据 | 不写入或迁移业务数据 | Session、设置和凭据 |

### 动态路由可见的变化

1. **受控请求头**
   - `Host`：当前 loopback authority
   - `Origin`：对应的 HTTP Origin
   - `Sec-Fetch-Site`：`same-origin`
2. **删除代理来源头**
   - `Forwarded`
   - `X-Forwarded-For`
   - `X-Real-IP`
3. **同步的 Node 视图**
   - `headers`
   - `rawHeaders`
   - `headersDistinct`
4. **socket 来源**
   - `request.socket.remoteAddress`：`127.0.0.1`
   - `request.socket.remoteFamily`：`IPv4`
5. **实际连接**
   - 不修改底层 TCP socket
   - 同一 keep-alive 连接复用同一个 socket facade

### 安装包入口

- `dsh-loopback-spoof`：官方 Host Connection 的原样重导出；
- `dsh-loopback-spoof/webserver`：Host WebServer 替代 provider；
- `dsh-loopback-spoof/client`：生成后的浏览器 Connection provider。

`cordis.patch.yml` 只负责 Profile composition：

1. 禁用官方 WebServer 行。
2. 禁用官方 Connection 行。
3. 挂载组合包的 WebServer 与 Connection 入口。
4. 保留 Cordis 对两种 provider 的独立依赖、失败和卸载管理。

## 已知限制

1. **触发位置**：浏览器会话 UI 的图片草稿和附件路径。
2. **上游调用**：`crypto.randomUUID()`。
3. **影响**：普通 HTTP LAN 页面不是 secure context，图片附件路径可能不可用。
4. **处理方式**：使用提供 TLS 的上游入口。
5. **本项目边界**：不扩大浏览器产物变换范围来修补其他官方模块。

## 开发与发布检查

### 快速检查

```bash
pnpm install --frozen-lockfile
pnpm run check:quick
```

快速检查包含：

1. TypeScript 类型检查。
2. 单元测试。
3. 清理 `lib/` 后重新构建。
4. 确认产物不缺失、不陈旧、不夹带旧 source map。

`build:package` 是快速检查、tarball 验证和归档预览共享的干净构建入口；生成的 `lib/` 必须随源码提交。

### 完整检查

以下来源二选一，两个环境变量不能同时设置。

#### 选项 A：DeepSeek Harness 源码工作区

要求：Web 前端已经构建。

```bash
export DSH_HARNESS_ROOT='/path/to/deepseek-harness'
pnpm run check
```

#### 选项 B：已安装的 DSH

要求：指向目标 Profile 使用的绝对 `lib/bin.js`。

```bash
export DSH_BIN_PATH='/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js'
pnpm run check
```

完整检查会：

- 生成并安装实际 `.tgz` 到随机临时 `DSH_HOME`；
- 验证安装前 403、安装后 426、真实 WebSocket 和浏览器 Connection；
- 验证默认 LAN 监听、显式 `--host 127.0.0.1` 和卸载恢复；
- 停止临时进程并删除临时 Profile 与 tarball。

> **完整检查的网络风险**
>
> - 会在随机端口短暂绑定 `0.0.0.0`。
> - 只能在受信任或隔离网络、防火墙已启用的构建机上运行。
> - 机器必须至少有一个 non-internal IPv4 地址。
> - 只有 loopback 接口时，可以运行 `check:quick`，但不能声称 LAN 集成已验证。

### 单项检查

```bash
pnpm run check:public     # 扫描公开文件中的敏感内容
pnpm run test:integration # 从当前源码运行 Profile 集成
pnpm run test:tarball     # 重新构建并验证实际打包归档
pnpm run pack:check       # 重新构建并预览归档清单
```

## 许可证

[MIT](LICENSE)
