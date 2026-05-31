# GitHub Pages + Cloudflare Worker 部署

## 1. 准备 GitHub Pages

把这些文件放进 GitHub 仓库：

```text
index.html
style.css
app.js
config.js
worker.js
```

在仓库设置里打开 Pages：

```text
Settings -> Pages -> Build and deployment -> Deploy from a branch
```

选择 `main` 分支和根目录。

## 2. 部署 Cloudflare Worker

在 Cloudflare 后台创建 Worker，把 `worker.js` 的内容粘进去并部署。

可选环境变量：

```text
BANGUMI_TOKEN=你的 Bangumi token
BANGUMI_USER_AGENT=AkaishiTableGenerator/1.0 (你的联系方式)
```

部署后会得到类似这样的地址：

```text
https://akaishi-worker.your-name.workers.dev
```

## 3. 连接前端和 Worker

打开 `config.js`，把地址填进去：

```js
window.AKAISHI_API_BASE = "https://akaishi-worker.your-name.workers.dev";
```

提交到 GitHub 后，GitHub Pages 会更新网页。

## 4. 验证

打开：

```text
https://akaishi-worker.your-name.workers.dev/api/health
```

如果返回：

```json
{"ok":true,"service":"akaishi-worker"}
```

说明 Worker 正常。

然后打开 GitHub Pages 网站，搜索 Bangumi 作品测试。
