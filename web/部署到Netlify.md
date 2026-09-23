# 把「阅读背词」分享给别人使用（部署到 Netlify）

现在这个网页已经是「本地版 + 在线分享版」双模式：

- **本地版**：`cd web && node server.js`，保留「电脑 + 手机扫码上传」。
- **在线分享版**：部署到 Netlify 后，任何人打开链接就能用（直接上传照片 → 识别 → 本地词库秒查 → 导出 PDF）。在线版同样支持「手机扫码上传」：电脑页面显示二维码，手机扫一扫拍照，照片会暂存在 Netlify 云端，24 小时后自动清理，电脑端会自动收到。

> 本地词典 `public/data/dict-3500.json`（中考/高考/雅思，约 6400 词）会随网站一起发布；查词优先本地秒出，本地没有的词会自动联网查询。
>
> 网页已针对手机做了适配；在线版「手机扫码上传」依赖 Netlify 云函数 + 云端存储，因此请用下面的**方式一**或**方式二**部署（**方式三 Drop 是纯静态预览，扫码上传不可用**）。

---

## 方式一：用 GitHub 自动部署（推荐）

适合长期使用，以后每次更新只要把代码推送到 GitHub，网站会自动更新。

### 第 1 步：把项目放到 GitHub

1. 在电脑浏览器打开 <https://github.com/new>，新建一个仓库（名字随意，比如 `read-vocab`），设为 **Private 或 Public 都行**。
2. 打开电脑上的「终端」（Terminal），粘贴运行下面这些命令（把 `你的GitHub用户名` 和 `你的仓库名` 换成真实的）：

```bash
cd "/Users/apple/Documents/Codex/2026-09-05/ios-app-store-n-vi-vt-2"
git init
git add .
git commit -m "阅读背词：本地版 + Netlify 在线分享版"
git branch -M main
git remote add origin https://github.com/你的GitHub用户名/你的仓库名.git
git push -u origin main
```

### 第 2 步：在 Netlify 导入这个仓库

1. 打开 <https://app.netlify.com>，登录你的账号。
2. 点 **Add new site → Import an existing project**。
3. 选 **GitHub**，授权后选择刚才的仓库。
4. Netlify 会自动读取项目里的 `netlify.toml`：
   - 发布目录：`web/public`
   - 云函数目录：`web/netlify/functions`
5. 什么都不用改，直接点 **Deploy**。

部署完成后，Netlify 会给你一个 `https://xxx.netlify.app` 的链接，把它发给别人即可。

---

## 方式二：用 Netlify CLI 从本机直接发布（不用 GitHub）

如果你不想注册 GitHub，也可以直接用命令行发布。

1. 安装 Netlify 命令行工具（只需要做一次）：

```bash
npm install -g netlify-cli
```

2. 登录并发布：

```bash
cd "/Users/apple/Documents/Codex/2026-09-05/ios-app-store-n-vi-vt-2"
netlify login
netlify init
netlify deploy --prod
```

`netlify login` 会打开浏览器让你确认；`netlify init` 会让你「创建新站点或选择已有站点」，一路回车选默认即可。

---

## 方式三：快速预览（Netlify Drop，最简单，但联网查词可能不稳定）

Netlify Drop 只能发布静态文件，不能带云函数。日常预览可以这样做：

1. 打开 <https://app.netlify.com/drop>。
2. 把电脑上的这个文件夹拖进去：

```
/Users/apple/Documents/Codex/2026-09-05/ios-app-store-n-vi-vt-2/web/public
```

这样能得到一个临时链接。本地词库、OCR、导出 PDF 都能用；只是「本地没有的词」的联网查词可能因为浏览器跨域限制而失败。

> 正式分享给别人，建议用**方式一**或**方式二**。

---

## 以后更新网站

- 用方式一部署的：改完代码后运行 `git add . && git commit -m "更新" && git push`，Netlify 会自动重新部署。
- 用方式二部署的：改完代码后重新运行 `netlify deploy --prod`。
