// API配置文件
// 用于管理不同环境的API地址
// 
// 💡 快速切换提示：
// 要在模拟服务器和真实服务器之间切换，请修改 config/server-mode.js 文件中的 USE_MOCK_SERVER 配置

const { getCurrentServerConfig } = require('./server-mode.js');

const serverConfig = getCurrentServerConfig();
const currentUrl = serverConfig.url;

const API_CONFIG = {
  // 开发环境配置
  development: {
    // 本地开发服务器
    local: currentUrl,
    // 原始模拟服务器
    original: currentUrl,
    // Swagger Mock服务器
    swagger: currentUrl,
    // ngrok内网穿透服务器
    ngrok: currentUrl,
    // 真实后端服务器（开发环境）
    backend: currentUrl,
    // 当前使用的服务器（可以切换）
    current: currentUrl // 统一使用指定服务器
  },
  
  // 测试环境配置
  testing: {
    local: currentUrl,
    ngrok: currentUrl,
    backend: currentUrl,
    current: currentUrl
  },
  
  // 生产环境配置
  production: {
    local: currentUrl,
    ngrok: currentUrl,
    backend: currentUrl,
    current: currentUrl
  }
};

// 获取当前环境
const getCurrentEnv = () => {
  // 可以根据实际需求调整环境判断逻辑
  return process.env.NODE_ENV || 'development';
};

// 获取当前API配置
const getCurrentConfig = () => {
  const env = getCurrentEnv();
  return API_CONFIG[env] || API_CONFIG.development;
};

// 切换API服务器
const switchApiServer = (serverType) => {
  const env = getCurrentEnv();
  const config = API_CONFIG[env];
  
  if (config && config[serverType]) {
    config.current = config[serverType];
    return config.current;
  } else {
    return null;
  }
};

// 获取所有可用的服务器类型
const getAvailableServers = () => {
  const env = getCurrentEnv();
  const config = API_CONFIG[env];
  return Object.keys(config).filter(key => key !== 'current');
};

// 获取当前服务器信息
const getCurrentServerInfo = () => {
  const config = getCurrentConfig();
  const availableServers = getAvailableServers();
  
  return {
    current: config.current,
    environment: getCurrentEnv(),
    available: availableServers.map(type => ({
      type,
      url: config[type]
    }))
  };
};

// 验证服务器连接
const validateServer = async (serverUrl) => {
  try {
    // 这里可以添加实际的连接测试逻辑
    return {
      valid: true,
      url: serverUrl,
      message: '服务器连接正常'
    };
  } catch (error) {
    return {
      valid: false,
      url: serverUrl,
      message: `服务器连接失败: ${error.message}`
    };
  }
};

// 导出配置
export {
  API_CONFIG,
  getCurrentConfig,
  getCurrentEnv,
  switchApiServer,
  getAvailableServers,
  getCurrentServerInfo,
  validateServer
};

// 默认导出
export default {
  API_CONFIG,
  getCurrentConfig,
  getCurrentEnv,
  switchApiServer,
  getAvailableServers,
  getCurrentServerInfo,
  validateServer
};
