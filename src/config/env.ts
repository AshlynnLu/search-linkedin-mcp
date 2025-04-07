/**
 * 环境变量工具函数
 * 参考mcp-server-flomo项目实现
 */

// 环境变量名称常量
export const ENV_NAMES = {
  // Google搜索API密钥
  SERPER_API_KEY: 'SHANGJI_SERPER_DEV_WEB_SEARCH_KEY',
  // OpenAI API密钥
  OPENAI_API_KEY: 'OPENAI_API_KEY',
  // 本地API密钥
  LOCAL_API_KEY: 'API_KEY',
  // 代理服务器
  PROXY_SERVER: 'PROXY_SERVER',
  // 代理用户名
  PROXY_USERNAME: 'PROXY_USERNAME',
  // 代理密码
  PROXY_PASSWORD: 'PROXY_PASSWORD'
};

// 默认值（已移除，用户必须提供自己的环境变量）
const DEFAULT_VALUES: Record<string, string> = {};

/**
 * 获取环境变量值
 * @param name 环境变量名称
 * @returns 环境变量值或默认值
 */
export function getParamValue(name: string): string {
  // 转为大写
  const envName = name.toUpperCase();
  
  // 先尝试从环境变量获取
  const envValue = process.env[envName];
  if (envValue) {
    return envValue;
  }
  
  // 返回默认值（为空）
  return DEFAULT_VALUES[envName] || '';
}

/**
 * 从请求中获取认证信息
 * @param request MCP请求对象
 * @param name 参数名称
 * @returns 参数值
 */
export function getAuthValue(request: any, name: string): string {
  try {
    // 转为小写
    const paramName = name.toLowerCase();
    
    // 从请求的auth对象获取
    if (request.auth && request.auth[paramName]) {
      return request.auth[paramName];
    }
    
    // 从请求的headers获取
    if (request.headers && request.headers['x-auth-' + paramName]) {
      return request.headers['x-auth-' + paramName];
    }
    
    return '';
  } catch (error) {
    return '';
  }
} 