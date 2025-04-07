# MCP Server 2Brain

基于MCP协议的专业公司信息验证服务器。

## 功能

- **公司搜索**：搜索公司的LinkedIn页面和其他相关信息
- **公司验证**：验证LinkedIn页面是否是公司的官方页面
- **公司信息提取**：从公司页面提取关键信息

## ⚠️ 重要提示：环境变量配置

本服务器**必须**配置以下环境变量才能正常工作：

### 必需的API密钥

- `SHANGJI_SERPER_DEV_WEB_SEARCH_KEY` - Google搜索API密钥（使用Serper服务）
- `OPENAI_API_KEY` - OpenAI API密钥（用于验证功能）

### 推荐的代理配置（提高访问稳定性）

- `PROXY_SERVER` - 代理服务器地址（如 "proxy.example.com:31212"）
- `PROXY_USERNAME` - 代理用户名
- `PROXY_PASSWORD` - 代理密码

## 安装

1. 克隆仓库：
```bash
git clone git@github.com:yourusername/mcp-server-2brain.git
cd mcp-server-2brain
```

2. 安装依赖：
```bash
npm install
```

3. 编译TypeScript代码：
```bash
npm run build
```

4. 确保安装Playwright浏览器（首次运行会自动安装）：
```bash
npx playwright install chromium --with-deps
```

## 配置

### 在Claude Desktop中配置

编辑Claude Desktop配置文件：

- MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "shangjitong": {
      "command": "node",
      "args": ["<项目路径>/build/index.js"],
      "env": {
        "SHANGJI_SERPER_DEV_WEB_SEARCH_KEY": "your-serper-api-key",
        "OPENAI_API_KEY": "your-openai-api-key",
        "PROXY_SERVER": "proxy.example.com:1234",
        "PROXY_USERNAME": "username",
        "PROXY_PASSWORD": "password"
      }
    }
  }
}
```

### 在环境中直接设置

```bash
export SHANGJI_SERPER_DEV_WEB_SEARCH_KEY=your-serper-api-key
export OPENAI_API_KEY=your-openai-api-key
export PROXY_SERVER=proxy.example.com:1234
export PROXY_USERNAME=username
export PROXY_PASSWORD=password
npm run start
```

## 使用方法

启动服务器：

```bash
npm run start
```

或者直接运行脚本：

```bash
./scripts/start.sh
```

服务启动后，如果有任何环境变量未配置，会在日志中显示警告信息。

## 功能示例

服务器支持以下MCP协议功能：

1. `search_company`: 搜索公司LinkedIn页面（需要配置SHANGJI_SERPER_DEV_WEB_SEARCH_KEY）
   - 参数: `company_name` (公司名称)
   - 返回: 搜索结果列表

2. `crawl_company`: 爬取指定URL的页面内容（推荐配置代理信息）
   - 参数: `url` (要爬取的URL)
   - 返回: 爬取的页面内容

3. `crawl_multiple_pages`: 并行爬取多个URL的页面内容（推荐配置代理信息）
   - 参数: `urls` (要爬取的URL列表)
   - 返回: 所有爬取的页面内容

4. `verify_company_content`: 验证页面内容是否匹配指定公司（需要配置OPENAI_API_KEY）
   - 参数: `company_name`, `page_content`, `page_url`
   - 返回: 验证结果

5. `verify_multiple_contents`: 批量验证多个页面内容（需要配置OPENAI_API_KEY）
   - 参数: `company_name`, `pages` (URL和内容列表)
   - 返回: 所有验证结果和最佳匹配

6. `verify_company`: 完整验证流程，包括搜索、爬取和验证（需要配置所有环境变量）
   - 参数: `company_name`, `official_website` (可选)
   - 返回: 验证结果，包含匹配的LinkedIn页面URL

## 日志

所有组件都会生成单独的日志文件：

- `mcp-server.log`: 主服务器日志
- `crawler.log`: 网页爬虫日志
- `google.log`: Google搜索日志
- `llm.log`: 大模型API日志

## 获取API密钥

1. SerperDev API密钥：访问 https://serper.dev/ 注册账号获取
2. OpenAI API密钥：访问 https://platform.openai.com/ 注册账号获取

## 故障排除

如果遇到问题：

1. 检查各组件日志文件
2. 确保所有环境变量都已正确配置
3. 验证代理服务器连接是否正常
4. 确认API密钥是否有效

## 许可

Copyright © 2023-2024 Shanghai 2Brain Technology Co., Ltd.
