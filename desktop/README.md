# 桌面端说明

当前仓库提供两种桌面使用方式：

## 1. 轻量桌面窗口（推荐，Windows 自带 WebView2 / Edge）

```powershell
npm run desktop
```

或直接运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/desktop.ps1
```

脚本会：
1. 安装依赖（首次）
2. 在后台启动 Node 服务
3. 用 Edge 的 App 模式打开控制面板窗口（无地址栏、像本地软件）

关闭窗口后，后台服务仍在运行；需要停止时结束 `node` 进程。

## 2. 浏览器直接打开

```powershell
npm start
```

然后访问 http://127.0.0.1:8787

## 可选：打包成原生应用

如果以后需要独立 exe，推荐用 Tauri（轻量、体积小）。核心服务保持不变，只需让 Tauri 窗口加载本地面板 URL，或把 `ui/` 静态文件打进前端。这个阶段先不引入 Rust 工具链，保持框架轻量。
