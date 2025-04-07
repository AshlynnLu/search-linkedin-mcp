#!/bin/bash

# 提示用户配置环境变量
echo "==========================================================="
echo "          汇商通 - 商机智能验证服务启动 v0.1.0            "
echo "==========================================================="
echo "请确保已配置以下环境变量:"
echo "- SHANGJI_SERPER_DEV_WEB_SEARCH_KEY: Google搜索API密钥"
echo "- OPENAI_API_KEY: OpenAI API密钥"
echo "- PROXY_SERVER: 代理服务器地址"
echo "- PROXY_USERNAME: 代理用户名"
echo "- PROXY_PASSWORD: 代理密码"
echo "==========================================================="

# 清理环境
echo "清理先前的日志文件..."
rm -f *.log

# 构建项目
echo "构建项目..."
npm run build

# 启动MCP Inspector
echo "启动MCP Inspector..."
export NODE_OPTIONS="--no-warnings"
export MCP_REQUEST_TIMEOUT=300000  # 设置为300秒
npx @modelcontextprotocol/inspector build/index.js 