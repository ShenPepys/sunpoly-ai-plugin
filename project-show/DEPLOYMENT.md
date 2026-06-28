# 盛宝利集团网站部署指南

##  目录结构

```
project-show/
└── ai-plugin-website/          ← 只需复制此目录到服务器
    ├── index.html              ← 主页（产品矩阵 + AI 助手）
    ├── dotco.html              ← Dot&Co 详情页
    ├── style.css               ← 共享样式文件
    ├── wechat-qr.JPG           ← 微信二维码
    ├── assets/                 ← 图标等资源
    │   └── icon.png
    └── dotco-screenshots/      ← Dot&Co 界面截图（20 张）
        ├── web-home.png
        ├── web-login.png
        ├── admin-dashboard.png
        └── ... (共 20 张)
```

## 🚀 部署步骤

### Windows 服务器

#### 方法一：直接复制（推荐）

```powershell
# 在服务器上执行
Copy-Item "ai-plugin-website\*" "C:\www\" -Recurse -Force
```

#### 方法二：使用 robocopy（支持增量同步）

```powershell
robocopy "ai-plugin-website" "C:\www" /MIR /R:3 /W:5
```

### Linux 服务器

```bash
# 复制所有文件到 web 根目录
cp -r ai-plugin-website/* /var/www/html/

# 或使用 rsync（推荐）
rsync -avz --delete ai-plugin-website/ /var/www/html/
```

##  Web 服务器配置

你的服务器上同时安装了 **Nginx** 和 **Caddy**，推荐使用 **Caddy**（更简单，自动 HTTPS）。

### 方案一：使用 Caddy（推荐 ）

#### 1. 安装 Caddy（如果未安装）
```powershell
# Windows 上可以使用 Chocolatey
choco install caddy

# 或从官网下载：https://caddyserver.com/download
```

#### 2. 配置 Caddyfile
将 `Caddyfile.example` 复制到 `C:\caddy\Caddyfile`，然后修改：

```caddy
sunpoly.vip {
    root * C:/www
    file_server
    try_files {path} {path}/ /index.html
}
```

#### 3. 启动 Caddy
```powershell
# 测试配置
caddy validate --config C:/caddy/Caddyfile

# 启动服务
caddy run --config C:/caddy/Caddyfile

# 或作为 Windows 服务运行
caddy service install --config C:/caddy/Caddyfile
net start caddy
```

**优点：**
- ✅ 自动获取和管理 Let's Encrypt SSL 证书
- ✅ 配置极其简单
- ✅ 默认启用 HTTP/2 和 HTTPS

---

### 方案二：使用 Nginx

#### 1. 配置 Nginx
将 `nginx.conf.example` 中的 server 块复制到你的 Nginx 配置文件：

**Windows Nginx 常见位置：**
- `C:\nginx\conf\nginx.conf`（主配置文件）
- `C:\nginx\conf\sites-enabled\sunpoly.conf`（独立站点配置）

#### 2. 关键配置
```nginx
server {
    listen 80;
    server_name sunpoly.vip www.sunpoly.vip;
    root C:/www;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

#### 3. 重启 Nginx
```powershell
# 测试配置
nginx -t

# 重新加载配置
nginx -s reload

# 或重启服务
net stop nginx
net start nginx
```

#### 4. HTTPS 配置（可选）
如果需要 HTTPS，需要：
1. 获取 SSL 证书（Let's Encrypt 或购买）
2. 将证书放在 `C:\ssl\` 目录
3. 取消注释 `nginx.conf.example` 中的 HTTPS server 块
4. 修改证书路径并重启 Nginx

**优点：**
- ✅ 性能优秀
- ✅ 功能强大，适合复杂场景
- ❌ HTTPS 配置较复杂（需手动管理证书）

---

## ✅ 验证清单

部署后访问以下 URL 确认一切正常：

| URL | 预期结果 |
|-----|---------|
| `http://sunpoly.vip/` | 显示产品矩阵主页 |
| `http://sunpoly.vip/index.html` | 同上 |
| `http://sunpoly.vip/dotco.html` | 显示 Dot&Co 详情页 |
| `http://sunpoly.vip/assets/icon.png` | 显示图标 |
| `http://sunpoly.vip/wechat-qr.JPG` | 显示微信二维码 |

### 功能测试

1. ✅ 点击主页"产品矩阵"中的"Dot&Co"卡片 → 跳转到 `dotco.html`
2. ✅ 点击 Dot&Co 页面导航栏的"首页" → 返回 `index.html`
3. ✅ 所有图片正常加载
4. ✅ 样式正确应用

## ⚠️ 注意事项

1. **只需上传 `ai-plugin-website/` 目录的内容**
   -  不要上传 `showcase-pingdou/`（已废弃）
   - ❌ 不要上传根目录下的 `screenshot_*.png`（测试截图）

2. **文件路径都是相对路径**
   - 不需要修改任何 HTML 或 CSS 文件
   - 直接复制到服务器 web 根目录即可

3. **Web 服务器配置**
   - 确保 `.html`、`.css`、`.png`、`.jpg` 等静态文件可以正常访问
   - Windows IIS：启用静态内容服务
   - Nginx/Apache：默认支持静态文件

## 🔄 更新流程

当需要更新网站时：

1. 在本地修改 `ai-plugin-website/` 中的文件
2. 重新复制整个目录到服务器（覆盖旧文件）
3. 刷新浏览器缓存（Ctrl+F5）验证效果

---

## 📦 VSIX 插件发布流程

### Gitee Release（国内用户推荐）

由于 GitHub 在国内访问需要翻墙，建议使用 **Gitee** 发布插件。

#### 步骤 1：创建 Gitee Release

1. 访问：**https://gitee.com/Mr-Pepys/plugins/releases/new**
2. 填写信息：
   ```
   Tag 版本: v0.1.14
   标题: v0.1.14
   描述: AI 助手插件 v0.1.14 版本发布
         
         ## 更新内容
         - 支持 DeepSeek、OpenAI 等主流模型
         - Ask/Code/Plan 三种工作模式
         - 代码解释、Bug 修复、优化、续写、单测生成
         - Diff 预览与一键撤销
         - 多会话管理
         - 右键快捷命令
   ```
3. **上传附件**：
   - 点击“添加附件”或拖拽文件
   - 选择：`d:\Project\plugins\my-ai-plugin\sunpoly-ai-plugin-0.1.14.vsix`
   - 文件大小：约 9.86 MB
4. 点击 **“发布”**

#### 步骤 2：验证下载链接

发布后，访问以下 URL 应该能直接下载：
```
https://gitee.com/Mr-Pepys/plugins/releases/download/v0.1.14/sunpoly-ai-plugin-0.1.14.vsix
```

#### 步骤 3：更新主页下载链接

如果版本号变更，需要修改 `index.html` 中的下载链接：

```html
<!-- 修改前 -->
<a href="https://gitee.com/Mr-Pepys/plugins/releases/download/v0.1.14/sunpoly-ai-plugin-0.1.14.vsix">

<!-- 修改后（例如升级到 v0.1.15） -->
<a href="https://gitee.com/Mr-Pepys/plugins/releases/download/v0.1.15/sunpoly-ai-plugin-0.1.15.vsix">
```

同时更新页面上的版本号显示：
```html
<span class="meta-item">📦 当前版本：<strong>v0.1.15</strong></span>
```

---

### GitHub Release（国际用户）

如果需要同时发布到 GitHub（供国际用户下载）：

#### 步骤 1：推送代码和标签到 GitHub

```bash
cd d:\Project\plugins\my-ai-plugin

# 推送代码
git push github master

# 推送标签
git push github v0.1.14
```

#### 步骤 2：创建 GitHub Release

1. 访问：**https://github.com/ShenPepys/sunpoly-ai-plugin/releases/new**
2. 选择 tag：`v0.1.14`
3. 填写标题和描述
4. 上传 `sunpoly-ai-plugin-0.1.14.vsix`
5. 点击 **“Publish release”**

#### 步骤 3：验证下载链接

```
https://github.com/ShenPepys/sunpoly-ai-plugin/releases/download/v0.1.14/sunpoly-ai-plugin-0.1.14.vsix
```

---

### 快速检查清单

- [ ] .vsix 文件已构建（`my-ai-plugin/sunpoly-ai-plugin-X.X.XX.vsix`）
- [ ] Gitee Release 已创建并上传附件
- [ ] 下载链接可正常访问（无需翻墙）
- [ ] 主页 `index.html` 中的下载链接已更新
- [ ] 主页显示的版本号与实际一致
- [ ] （可选）GitHub Release 已创建

---

**最后更新：** 2026-06-27  
**版本：** v0.1.14
