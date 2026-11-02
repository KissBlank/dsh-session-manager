# 发布手册（Release runbook）

包名：`@kissblank/dsh-session-manager`（npm scope = npm 用户名 `kissblank`）
仓库：<https://github.com/KissBlank/dsh-session-manager>
发布方式：**推 tag → GitHub Actions 用 npm Trusted Publishing（OIDC）自动发版**，本机不存任何 npm token。

> 1.0.0 起仓库与包同名 `@kissblank/dsh-session-manager`，信任关系是新建的：新建的包名第一次必须手工（或临时 token）把包建出来，之后才能登记 Trusted Publisher。

---

## 0. 一次性配置（已完成 ✅）

### 0.1 在 npm 上登记 Trusted Publisher — 已配好

当前状态（`https://www.npmjs.com/package/@kissblank/dsh-session-manager/access`）：

| 项 | 值 |
|---|---|
| Publisher | GitHub Actions |
| Label | `dsh-session-manager release` |
| Organization or user / Repository | `KissBlank` / `dsh-session-manager` |
| Workflow filename | `release.yml` |
| Environment | 留空 |
| Permissions | `npm publish` + `npm stage publish` |
| Status | 首次通过 CI 发布后自动变 **Valid** |

> 勾了 **Allow npm publish**，所以 CI 是**直接发布**，不需要每次人工批准。若以后想改成"必须人工批准"，把该勾去掉，再把 `release.yml` 的 `npm publish` 换成 `npm stage publish`，然后到 <https://www.npmjs.com/settings/kissblank/staged-packages> 点 Approve。

### 0.2 关掉旧的 bypass-2FA token — 已删除

`dsh-session-manager-publish` 已删除（`/-/whoami` 用旧 token 现在返回 401）。**当前不存在任何长期 npm token**，发布完全走 OIDC。

如果哪天需要临时手工发版，再生成一个 granular token（记得删掉用完的），或者直接用 `npm stage publish` + 浏览器批准。

> 备注：npm 从 2027-01 起会彻底移除 "bypass 2FA 的 granular token 直接发布" 这条路，Trusted Publishing 是官方推荐的替代方案。

---

## 1. 日常发布（三步）

```bash
# 1) 改版本号（同时改 CHANGELOG.md）
npm version patch   # 或 minor / major；会生成提交和 vX.Y.Z tag

# 2) 跑测试
node test/host-smoke.mjs && node test/client-smoke.cjs

# 3) 先推提交，再单独推 tag
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin v1.0.0   # 换成实际 tag
```

**tag 要和 main 分开推**：实测把 `main` 和新建的 tag 放进同一次 `push` 时，Actions 没有排队（`actions/runs` 为 0）；删掉 tag 后再单独推一次，流水线立刻就跑起来了。`npm version` 已经建好 tag，所以拆成两条 push 即可。

tag 一推上去：

- `.github/workflows/release.yml` 触发
- 先校验 `tag 去掉 v` 与 `package.json` 的 `version` 完全一致（不一致直接失败）
- 跑两套冒烟测试
- `npm publish --access public --provenance`（若该版本已存在则跳过并打 `::notice::`，重复推 tag 不会报错）

发布完成后确认：

```bash
curl -s https://registry.npmjs.org/@kissblank%2Fdsh-session-manager | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['dist-tags']))"
```

看到 `{"latest":"X.Y.Z"}` 且对应 tarball 能下载（`curl -I` 返回 200）才算真的上线。

---

## 2. 手工发版（CI 不可用时）

仅在必要时使用，且**必须先开 2FA**：

```bash
npx npm@latest stage publish --access public   # 上传到暂存区
# 打开 https://www.npmjs.com/settings/kissblank/staged-packages
# 点 Approve → 用通行密钥（Windows Hello）验证
```

npm 现在要求：**编辑包（包括批准暂存版本）必须有 2FA**。如果 2FA 是通行密钥（WebAuthn），命令行 `--otp` 永远过不去，只能在浏览器里点。

---

## 3. 常见问题

### 3.1 装不上、报 `Unexpected token '﻿'`

包里的 `package.json` 带了 BOM。这个坑来自用 Windows PowerShell 的 `Set-Content -Encoding utf8` 写文件（PS 5.1 会写 BOM）。改版本号请用下面两种方式之一：

```powershell
# 方式 A：让 npm 改（推荐）
npm version patch

# 方式 B：手写时用无 BOM 编码
$text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $text, $enc)
```

发版后自查一下包里的首字节：

```powershell
curl.exe -sSL -o "$env:TEMP\a.tgz" https://registry.npmjs.org/@kissblank/dsh-session-manager/-/dsh-session-manager-X.Y.Z.tgz
tar -xzf "$env:TEMP\a.tgz" -C "$env:TEMP\a"
[System.IO.File]::ReadAllBytes("$env:TEMP\a\package\package.json")[0..2]  # 应该是 7B 0A 20，不能是 EF BB BF
```

### 3.2 registry 里只有元数据、tarball 404

说明发布走了"暂存"流程但没被批准。去 <https://www.npmjs.com/settings/kissblank/staged-packages> 点 Approve；列表为空就说明还没上传成功，重新 `npm stage publish`。

### 3.3 装了但界面没反应

`lib/index.js` 改了必须**重启 DSH 桌面端**（路由在宿主启动时注册）；`lib/client.js` 改了刷新页面即可。另外装/换包名之后也必须重启——boot 清单是宿主启动时生成下发的。

### 3.4 想弃用某个版本

```bash
npm deprecate '@kissblank/dsh-session-manager@<旧版本>' '<为什么要升级>'
```

弃用只是给安装者一条警告，不删除包体（72 小时内也可以 `npm unpublish` 彻底删除，但尽量不要）。

---

## 4. 发布检查清单

- [ ] `CHANGELOG.md` 已写本次改动
- [ ] `package.json` 的 `version` 已提升，且与 tag 一致
- [ ] 许可证相关没被动坏：`package.json` 的 `license` 仍是 `SEE LICENSE IN LICENSE`，`LICENSE` 仍在发包文件里，README 的许可说明与 `LICENSE` 一致（自定义「保留所有权利」条款，**不要改回 MIT**）
- [ ] `node test/host-smoke.mjs` 通过（当前 43 项）
- [ ] `node test/client-smoke.cjs` 通过（当前 98 项）
- [ ] `npm pack --dry-run` 的文件清单符合预期（`lib/`、`locale/`、`assets/`、`cordis.patch.yml`、`LICENSE`、`README.md`）
- [ ] tag 推送后 Actions 绿灯，registry 的 `dist-tags.latest` 指向新版本
- [ ] 用包名实际装一次（插件管理器填 `@kissblank/dsh-session-manager@X.Y.Z`），重启 DSH，确认侧栏「会话管理」在
