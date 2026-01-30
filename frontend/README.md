# 前端项目

前端项目（Fork 或 Clone 自提供链接）。

## 说明

- 将小程序/H5 前端代码放置于此目录，或从提供的仓库地址 Fork/Clone 到本目录。
- 部署到 Render 时，可在此目录配置构建命令（如 `npm install && npm run build:h5`）和静态输出目录。

## 目录建议

若使用当前仓库的 uni-app 前端，可将以下内容放入本目录或通过子模块引用：

- `App.vue`、`main.js`、`pages/`、`components/`、`static/`、`index.html`
- `pages.json`、`manifest.json`、`uni.scss`、`project.config.json`
- 前端专用 `package.json`（Vue/uni-app 依赖与构建脚本）
