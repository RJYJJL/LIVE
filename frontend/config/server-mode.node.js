// config/server-mode.node.js (Node.js后端专用)
// 端口与主机：优先使用环境变量 PORT/HOST，便于部署到 Render 等平台
const os = require('os');
const USE_MOCK_SERVER = false; // 改为 false 使用真实服务器
const DEPLOY_PORT = parseInt(process.env.PORT || '8080', 10);
const DEPLOY_HOST = process.env.HOST || ''; // 部署时可设 HOST，不设则用本机 IP 显示

/** 获取本机局域网 IP（所在地 IP），用于启动时打印；未找到则返回 127.0.0.1 */
function getLocalIP() {
    if (DEPLOY_HOST) return DEPLOY_HOST;
    try {
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
            for (const iface of ifaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) { /* ignore */ }
    return '127.0.0.1';
}
const localIP = getLocalIP();
const REAL_SERVER_URL = `http://${localIP}:${DEPLOY_PORT}`;
const REAL_SERVER_PORT = DEPLOY_PORT;
const LOCAL_SERVER_URL = `http://localhost:${DEPLOY_PORT}`;
// 后端 API：网关代理到本机 Spring Boot（同机用 127.0.0.1 避免 ETIMEDOUT）
const BACKEND_SERVER_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
// 是否优先使用后端服务器（设为 true 时，所有 API 请求会优先代理到后端服务器）
// 注意：后台管理系统通过中间层代理访问后端服务器
// 🔧 强制使用真实服务器：设为 true，所有 API 请求直接代理到后端服务器，不使用本地mock数据
const PRIORITIZE_BACKEND_SERVER = true; // 设为 true 优先使用后端服务器，false 优先使用本地路由
const REAL_WECHAT_CONFIG = {
    appid: 'wx94289b0d2ca7a802',
    secret: '10409c1193a326a7b328f675b1776195'
};
const MOCK_SERVER_CONFIG = {
    host: localIP,
    port: DEPLOY_PORT,
    url: `http://${localIP}:${DEPLOY_PORT}`
};
const getCurrentServerConfig = () => {
    if (USE_MOCK_SERVER) {
        return {
            mode: 'mock',
            url: MOCK_SERVER_CONFIG.url,
            host: MOCK_SERVER_CONFIG.host,
            port: MOCK_SERVER_CONFIG.port,
            wechat: {
                useMock: true,
                appid: 'wx94289b0d2ca7a802',
                secret: '10409c1193a326a7b328f675b1776195'
            }
        };
    } else {
        // 使用真实服务器，部署模式
        return {
            mode: 'real',
            url: REAL_SERVER_URL,
            port: DEPLOY_PORT,  // 使用部署端口（8082）
            wechat: {
                useMock: false,
                appid: REAL_WECHAT_CONFIG.appid,
                secret: REAL_WECHAT_CONFIG.secret
            }
        };
    }
};
const printConfig = () => {
    const config = getCurrentServerConfig();
    console.log('═══════════════════════════════════════');
    console.log('📋 服务器配置信息');
    console.log('═══════════════════════════════════════');
    console.log(`模式: ${config.mode === 'mock' ? '🧪 模拟服务器' : '🌐 真实服务器'}`);
    console.log(`地址: ${config.url}`);
    if (config.mode === 'mock') {
        console.log(`本地访问: http://localhost:${config.port}`);
        console.log(`局域网访问: ${config.url}`);
    }
    console.log(`微信登录: ${config.wechat.useMock ? '模拟模式' : '真实模式'}`);
    if (!config.wechat.useMock) {
        console.log(`微信 AppID: ${config.wechat.appid}`);
        console.log(`微信 Secret: ${config.wechat.secret ? config.wechat.secret.substring(0, 8) + '...' : '未设置'}`);
    }
    console.log('═══════════════════════════════════════');
};
module.exports = {
	USE_MOCK_SERVER,
	MOCK_SERVER_CONFIG,
	REAL_SERVER_URL,
	REAL_SERVER_PORT,
	REAL_WECHAT_CONFIG,
	BACKEND_SERVER_URL,
	PRIORITIZE_BACKEND_SERVER,
	getCurrentServerConfig,
	printConfig,
	getLocalIP,
	LOCAL_SERVER_URL,
	DEPLOY_PORT,
	DEPLOY_HOST,
};
