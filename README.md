# dsh-loopback-spoof

> **安全警告**
>
> - 此 Bundle 默认将 DSH Web 监听地址改为 `0.0.0.0:3080`，并让已认证浏览器获得 loopback 能力判定。
> - 保留官方一次性启动令牌、签名 Cookie、Host/Origin 信任校验，不再伪造请求来源。
> - HTTP 本身不提供 TLS；启动 URL 中的令牌只能在可信网络传输，公网或不可信网络必须使用受信任的 TLS 入口和防火墙。
> - 官方认证只验证浏览器会话，不替代网络访问控制、速率限制或访问审计。

## 一眼了解

| 项目 | 说明 |
| --- | --- |
| 安装效果 | 默认启用 LAN 监听，并切换浏览器侧的 loopback 判断 |
| Host 请求 | 保留官方真实 Host、Origin、Cookie 与 socket 来源 |
| 浏览器连接 | `ctx.connection.isLoopback` 固定为 `true` |
| 官方复用 | 直接使用 DSH `0.1.3-alpha.1` 的 WebServer、认证、RPC 与 Host Connection |
| 持久化数据 | 不迁移 Session、设置或凭据 |
| 卸载结果 | 重启 Profile 后恢复官方 Connection 与默认监听配置 |

## 快速导航

1. [使用前必须确认](#使用前必须确认)
2. [安装](#安装)
3. [验证安装](#验证安装)
4. [卸载与回退](#卸载与回退)
5. [行为说明](#行为说明)
6. [开发与发布检查](#开发与发布检查)

## 使用前必须确认

- [ ] 防火墙、专用网络或受信任 TLS 入口已经限制 3080 端口。
- [ ] 当前 Web Profile 已停止。
- [ ] 当前 Web Profile 未同时启用其他替代 Connection provider 或覆盖 WebServer 监听配置的 Bundle。
- [ ] 已保留下方的回退命令。
- [ ] 已明确选择监听范围：
  - 默认：`0.0.0.0:3080`
  - 仅本机：启动时传入 `--host 127.0.0.1`

## 风险边界

### 通过启动令牌完成认证的调用方可能执行

1. 调用配置、凭据、Agent、工具和插件接口。
2. 调用第三方动态路由。
3. 使用原本只向本机浏览器呈现的能力：
   - 写入设置；
   - 打开配置文件；
   - 打开 Host 路径。
4. 让 DSH Host 携带调用方提供的草稿凭据请求指定地址。

### 不会改变

- 静态文件与 SPA fallback 不会被改写。
- 未认证页面请求仍返回 401，伪造 Host/Origin 的 API 与 WebSocket 请求仍返回 403。
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

- 只出现一个根 `dsh-loopback-spoof`。
- 官方 `webserver` 仍启用，`host` 默认为 `0.0.0.0`，压缩配置为 `gzip`。
- 官方 `@deepseek-ai/dsh-client-connection` 行为 disabled，由根 `dsh-loopback-spoof` 接替相同 Host 接口。
- 不再存在 `dsh-loopback-spoof/webserver` 子入口。

## 验证安装

```bash
ss -ltnp | grep ':3080'

curl --include \
  --header 'Host: dsh.example:3080' \
  --header 'Origin: http://dsh.example:3080' \
  --header 'Sec-Fetch-Site: cross-site' \
  'http://127.0.0.1:3080/api/remote.mux'
```

预期结果：

1. **监听范围**
   - 默认：`0.0.0.0:3080`
   - 传入 `--host 127.0.0.1`：仅本机监听
2. **认证与信任边界**
   - 未携带 Cookie 访问 `/` 返回 401
   - 上述伪造 Host/Origin 请求返回 403
   - `dsh web` 输出本机与 LAN 两个带 `?token=...` 的启动 URL；令牌仅用于首次换取签名 Cookie
3. **浏览器**
   - 从终端复制实际输出的 LAN 启动 URL 并打开，跳转后的地址不再包含令牌
   - 页面、官方 RPC 与 WebSocket 正常连接，且依赖 loopback 判定的能力可见

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

1. dump 不再包含根 `dsh-loopback-spoof` 入口。
2. 官方 Connection 在下一次启动时恢复，WebServer 恢复 Profile 原始监听配置。
3. 无需迁移或回滚业务数据。

## 行为说明

| 范围 | 安装后的行为 | 保持不变的部分 |
| --- | --- | --- |
| WebServer | 未传 `--host` 时监听 `0.0.0.0` | 官方实例、路由 dispatcher、压缩与生命周期 |
| 动态 HTTP 与 WebSocket | 使用真实请求头、Cookie 和 socket 来源 | 官方 Host/Origin 信任校验与浏览器认证 |
| Host Connection | 继续提供官方 `/api` HTTP 和 WebSocket | 官方 `0.1.3-alpha.1` Connection 实现 |
| 浏览器 Connection | `ctx.connection.isLoopback` 固定为 `true` | 官方 provider、RPC 和传输实现 |
| 静态文件与 SPA | 不改写请求 | 官方 `registerFallback()` 与 index 注入 |
| 持久化数据 | 不写入或迁移业务数据 | Session、设置和凭据 |

### 安装包入口

- `dsh-loopback-spoof`：官方 Host Connection 的原样重导出；
- `dsh-loopback-spoof/client`：生成后的浏览器 Connection provider。

`cordis.patch.yml` 只负责 Profile composition：

1. 原位配置官方 WebServer 的默认监听地址和压缩参数。
2. 禁用官方 Connection 行。
3. 挂载根 `dsh-loopback-spoof` Connection，并传入官方 Web runtime 推导的 `trustedHosts`。
4. 保留官方认证、请求信任、RPC、WebSocket 和 WebServer 生命周期。

## 已知限制

1. 当前兼容基线是官方 `deepseek-harness` `0.1.3-alpha.1`；预览版本的公开接口变化会让构建阶段主动失败，必须重新核对后升级。
2. 官方 alpha 包尚未发布到 registry；开发构建必须通过 `DSH_HARNESS_ROOT` 使用匹配版本的官方源码工作区。
3. 普通 HTTP LAN 页面不具备 TLS 保护；在不可信网络使用时必须放在受信任的 HTTPS 入口之后。
4. 本插件只改变浏览器 Connection 的 loopback 分类，不伪造 Host 请求、socket 地址或代理头。

## 开发与发布检查

### 快速检查

```bash
pnpm install --frozen-lockfile
export DSH_HARNESS_ROOT='/path/to/deepseek-harness'
pnpm run check:quick
```

快速检查包含：

1. TypeScript 类型检查。
2. 单元测试。
3. 清理 `lib/` 后重新构建。
4. 确认产物不缺失、不陈旧、不夹带旧 source map。

`build:package` 是快速检查、tarball 验证和归档预览共享的干净构建入口；生成的 `lib/` 必须随源码提交。

### 完整检查

当前仅支持 DeepSeek Harness 源码工作区，要求版本严格匹配 `package.json` 中的 Connection peer，且 Web 前端已经构建。

```bash
export DSH_HARNESS_ROOT='/path/to/deepseek-harness'
pnpm run check
```

完整检查会：

- 生成并安装实际 `.tgz` 到随机临时 `DSH_HOME`；
- 验证启动令牌换取 Cookie、未认证 401、伪造 Host/Origin 403、认证 WebSocket 和浏览器 Connection；
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
