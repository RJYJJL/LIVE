# 直播辩论后端 (Spring Boot)

Mock 数据服务，端口 **8000**，与前端/Node 中间层配合使用。

## 环境

- JDK 17+
- Maven 3.6+

## 启动

```bash
cd backend
mvn spring-boot:run
```

或先打包再运行：

```bash
mvn clean package -DskipTests
java -jar target/live-backend-1.0.0.jar
```

## 接口说明

- **统一响应格式**：`{ "code": 0, "message": "success", "data": {...}, "success": true }`
- **API 根路径**：`/api`、`/api/v1`、`/api/admin`、`/api/v1/admin`
- **WebSocket**：`ws://localhost:8000/ws`，消息类型：`liveStatus`、`votes-updated`、`aiStatus`、`newAIContent`、`debate-updated`、`connected`

## 主要接口（Mock）

| 功能           | 方法 | 路径 |
|----------------|------|------|
| 数据概览       | GET  | /api/v1/admin/dashboard?stream_id= |
| 开始/停止直播  | POST | /api/v1/admin/live/start, /live/stop |
| 更新/重置投票  | POST | /api/v1/admin/live/update-votes, /live/reset-votes |
| AI 启停/切换   | POST | /api/v1/admin/ai/start, /stop, /toggle |
| 直播流列表     | GET  | /api/v1/admin/streams |
| 用户列表       | GET  | /api/admin/miniprogram/users |
| 投票统计       | GET  | /api/admin/votes/statistics |
| 辩题/辩论流程   | GET/POST | /api/v1/admin/debates, /api/admin/debate-flow |
| 用户投票       | POST | /api/v1/user-vote |
| 获取票数/辩题  | GET  | /api/v1/votes, /api/v1/debate-topic |

**本地联调**：先启动后端 `mvn spring-boot:run`，再启动网关 `npm start`。网关监听 **8080**、代理 `/api` 到 `http://127.0.0.1:8000`。访问 `http://localhost:8080/admin` 或 `http://192.168.43.247:8080/admin` 均可。

**Vercel 部署**：Vercel 仅支持静态/Serverless。后端需单独部署（如 Railway、Render、自建），在网关侧设置环境变量 `BACKEND_URL` 为后端公网地址即可。

**Render 部署**：可将本目录 `/backend` 部署为独立 Web Service。构建命令：`mvn clean package -DskipTests`；启动命令：`java -jar target/live-backend-1.0.0.jar`（以实际 jar 名为准）。需设置 `PORT` 等环境变量。
